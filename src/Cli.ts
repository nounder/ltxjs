#!/usr/bin/env bun
import { lstat, link, mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as FileStore from "./FileStore.ts"
import * as Replica from "./Replica.ts"
import * as S3 from "./S3.ts"
import type { ObjectStore } from "./ObjectStore.ts"
import { version } from "../package.json"

const help = `Usage:
  ltxjs replicate [-once] DB_PATH REPLICA_URL
  ltxjs restore [-if-db-not-exists] [-if-replica-exists] -o PATH REPLICA_URL
  ltxjs version

Replica URLs: s3://BUCKET/PREFIX or file:///absolute/backup/path
An ordinary directory path is also accepted as a file destination.

S3 environment:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
  AWS_REGION (or AWS_DEFAULT_REGION; default us-east-1)
  AWS_ENDPOINT_URL_S3 (or AWS_ENDPOINT_URL) for S3-compatible services
  LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY as fallbacks

Litestream-style flags accept one or two dashes. No configuration files.
Continuous replication flushes pending changes on SIGINT or SIGTERM.
Unsupported Litestream commands and flags are rejected.
`

interface Arguments {
  readonly command: string
  readonly positional: string[]
  readonly flags: Map<string, string | boolean>
}

const parse = (args: readonly string[]): Arguments => {
  const command = args[0] ?? "help", flags = new Map<string, string | boolean>(), positional: string[] = []
  const allowed = command === "replicate" ? ["once"] : command === "restore" ? ["o", "if-db-not-exists", "if-replica-exists"] : []
  let literal = false
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (literal || !arg.startsWith("-")) { positional.push(arg); continue }
    if (arg === "--") { literal = true; continue }
    const [name, ...parts] = arg.replace(/^--?/, "").split("="), value = parts.length ? parts.join("=") : undefined
    if (name === "h" || name === "help") { flags.set("help", true); continue }
    if (!name || !allowed.includes(name)) throw new Error(`unsupported flag: ${arg.split("=")[0]}`)
    if (name === "o") {
      const output = value ?? args[++index]
      if (!output || output.startsWith("-")) throw new Error("-o requires an output path")
      flags.set(name, output)
    } else {
      if (value !== undefined && value !== "true" && value !== "false") throw new Error(`invalid boolean for -${name}`)
      flags.set(name, value !== "false")
    }
  }
  return { command, positional, flags }
}

/** The CLI URL points directly at Litestream's replica directory (0000/, etc.). */
export const replicaStore = (destination: string, env: NodeJS.ProcessEnv = process.env): ObjectStore => {
  let store: ObjectStore
  if (!/^[a-z][a-z0-9+.-]*:/i.test(destination)) store = FileStore.make(destination)
  else {
    const url = new URL(destination)
    if (url.username || url.password) throw new Error("replica credentials must be supplied through environment variables")
    if (url.search || url.hash) throw new Error("replica URL queries and fragments are unsupported; use environment variables for S3 options")
    if (url.protocol === "file:") store = FileStore.make(fileURLToPath(url))
    else if (url.protocol === "s3:") {
      if (!url.hostname || url.port) throw new Error("S3 URL must specify a bucket")
      const accessKeyId = env.AWS_ACCESS_KEY_ID || env.LITESTREAM_ACCESS_KEY_ID
      const secretAccessKey = env.AWS_SECRET_ACCESS_KEY || env.LITESTREAM_SECRET_ACCESS_KEY
      if (!accessKeyId || !secretAccessKey) throw new Error("S3 requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or LITESTREAM equivalents)")
      const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1"
      const endpoint = env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL
      store = S3.make({
        bucket: url.hostname, prefix: decodeURIComponent(url.pathname).replace(/^\/+/, ""), region,
        endpoint: endpoint || `https://s3.${region}.amazonaws.com`, pathStyle: Boolean(endpoint),
        accessKeyId, secretAccessKey,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {})
      })
    } else throw new Error(`unsupported replica scheme: ${url.protocol} (use s3:// or file://)`)
  }
  const key = (value: string) => value.startsWith("ltx/") ? value.slice(4) : value
  return Object.freeze<ObjectStore>({
    put: (name, value) => store.put(key(name), value),
    get: name => store.get(key(name)),
    remove: name => store.remove(key(name)),
    list: async prefix => (await store.list(key(prefix))).map(info => ({ ...info, key: prefix.startsWith("ltx/") ? `ltx/${info.key}` : info.key }))
  })
}

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

const restore = async (args: Arguments): Promise<void> => {
  const output = args.flags.get("o")
  if (args.positional.length !== 1 || typeof output !== "string") throw new Error("usage: ltxjs restore -o PATH REPLICA_URL")
  const path = resolve(output)
  if (await exists(path)) {
    if (args.flags.get("if-db-not-exists")) return
    throw new Error(`output path already exists: ${path}`)
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await exists(`${path}${suffix}`)) throw new Error(`SQLite sidecar already exists: ${path}${suffix}`)
  }
  const replica = Replica.make({ databasePath: path, store: replicaStore(args.positional[0]!) })
  const temporary = `${path}.ltxjs-${crypto.randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    try { await replica.restore(temporary) }
    catch (error) {
      if (args.flags.get("if-replica-exists") && error instanceof Error && error.message === "no LTX files found") return
      throw error
    }
    // Publishing by hard link fails if another process created the output meanwhile.
    await link(temporary, path)
    console.error(`restored ${path}`)
  } finally { await rm(temporary, { force: true }); await replica.stop() }
}

const replicate = async (args: Arguments): Promise<void> => {
  if (args.positional.length !== 2) throw new Error("usage: ltxjs replicate [-once] DB_PATH REPLICA_URL")
  const databasePath = resolve(args.positional[0]!)
  if (!(await exists(databasePath))) throw new Error(`database does not exist: ${databasePath}`)
  const replica = Replica.make({ databasePath, store: replicaStore(args.positional[1]!), onError: error => console.error(`replication error: ${error instanceof Error ? error.message : String(error)}`) })
  let signal!: () => void
  const interrupted = new Promise<void>(resolve => { signal = resolve })
  process.once("SIGINT", signal)
  process.once("SIGTERM", signal)
  try {
    await replica.sync()
    if (args.flags.get("once")) return
    console.error(`replicating ${databasePath}`)
    replica.start()
    await interrupted
    await replica.stop()
    await replica.sync()
  } finally {
    await replica.stop()
    process.removeListener("SIGINT", signal)
    process.removeListener("SIGTERM", signal)
  }
}

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
  const args = parse(argv)
  if (["help", "-h", "--help"].includes(args.command) || args.flags.get("help")) { console.log(help); return }
  if (args.command === "version") {
    if (args.positional.length) throw new Error("usage: ltxjs version")
    console.log(`ltxjs ${version}`)
  } else if (args.command === "replicate") await replicate(args)
  else if (args.command === "restore") await restore(args)
  else throw new Error(`unsupported command: ${args.command}\nRun ltxjs --help for usage.`)
}

if (import.meta.main) {
  try { await main() }
  catch (error) { console.error(`ltxjs: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
}
