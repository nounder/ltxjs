#!/usr/bin/env bun
import { lstat, link, mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as FileStore from "./FileStore.ts"
import * as Logger from "./Logger.ts"
import * as ObjectStore from "./ObjectStore.ts"
import * as Replica from "./Replica.ts"
import * as S3 from "./S3.ts"
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
Logging (replicate and restore):
  -log-level LEVEL   trace, debug, info, warn, error (default: LOG_LEVEL or info)
  -log-format TYPE   text or json (default: text)
  -log-stderr        Write logs to stderr (default: stdout)
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
  const logging = ["log-level", "log-format", "log-stderr"]
  const allowed = command === "replicate" ? ["once", ...logging] : command === "restore" ? ["o", "if-db-not-exists", "if-replica-exists", ...logging] : []
  let literal = false
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (literal || !arg.startsWith("-")) { positional.push(arg); continue }
    if (arg === "--") { literal = true; continue }
    const [name, ...parts] = arg.replace(/^--?/, "").split("="), value = parts.length ? parts.join("=") : undefined
    if (name === "h" || name === "help") { flags.set("help", true); continue }
    if (!name || !allowed.includes(name)) throw new Error(`unsupported flag: ${arg.split("=")[0]}`)
    if (name === "o" || name === "log-level" || name === "log-format") {
      const output = value ?? args[++index]
      if (!output || output.startsWith("-")) throw new Error(name === "o" ? "-o requires an output path" : `-${name} requires a value`)
      flags.set(name, output)
    } else {
      if (value !== undefined && value !== "true" && value !== "false") throw new Error(`invalid boolean for -${name}`)
      flags.set(name, value !== "false")
    }
  }
  return { command, positional, flags }
}

/** The CLI URL points directly at Litestream's replica directory (0000/, etc.). */
export const replicaStore = (destination: string, env: NodeJS.ProcessEnv = process.env): ObjectStore.ObjectStore => {
  let store: ObjectStore.ObjectStore
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
  return Object.freeze<ObjectStore.ObjectStore>({
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

const restore = async (args: Arguments, log: Logger.Logger): Promise<void> => {
  const output = args.flags.get("o")
  if (args.positional.length !== 1 || typeof output !== "string") throw new Error("usage: ltxjs restore -o PATH REPLICA_URL")
  const path = resolve(output)
  if (await exists(path)) {
    if (args.flags.get("if-db-not-exists")) { log("info", "database already exists, skipping", { path }); return }
    throw new Error(`output path already exists: ${path}`)
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await exists(`${path}${suffix}`)) throw new Error(`SQLite sidecar already exists: ${path}${suffix}`)
  }
  const replica = Replica.make({ databasePath: path, store: replicaStore(args.positional[0]!), logger: log })
  const temporary = `${path}.ltxjs-${crypto.randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    let position: Replica.Position
    try { position = await replica.restore(temporary) }
    catch (error) {
      if (args.flags.get("if-replica-exists") && error instanceof Error && error.message === "no LTX files found") { log("info", "no matching backups found", { path }); return }
      throw error
    }
    // Publishing by hard link fails if another process created the output meanwhile.
    await link(temporary, path)
    log("info", "restore completed", { path, txid: position.txId.toString(16).padStart(16, "0") })
  } finally { await rm(temporary, { force: true }); await replica.stop() }
}

const replicate = async (args: Arguments, log: Logger.Logger): Promise<void> => {
  if (args.positional.length !== 2) throw new Error("usage: ltxjs replicate [-once] DB_PATH REPLICA_URL")
  const databasePath = resolve(args.positional[0]!)
  if (!(await exists(databasePath))) throw new Error(`database does not exist: ${databasePath}`)
  const destination = args.positional[1]!
  const replica = Replica.make({ databasePath, store: replicaStore(destination), logger: log })
  // Describe only the validated storage location, never raw credentials or URL options.
  const url = /^[a-z][a-z0-9+.-]*:/i.test(destination) ? new URL(destination) : undefined
  const target = url?.protocol === "s3:" ? { type: "s3", bucket: url.hostname, path: decodeURIComponent(url.pathname).replace(/^\/+/, "") } : { type: "file", path: url ? fileURLToPath(url) : resolve(destination) }
  let signal!: (value: NodeJS.Signals) => void
  const interrupted = new Promise<NodeJS.Signals>(resolve => { signal = resolve })
  const onSigint = () => signal("SIGINT"), onSigterm = () => signal("SIGTERM")
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    log("info", "nodelite", { version })
    await replica.sync()
    log("info", "replicating to", { db: databasePath, ...target, "sync-interval": "1s" })
    if (args.flags.get("once")) { log("info", "one-shot replication complete"); return }
    replica.start()
    log("info", "signal received, nodelite shutting down", { signal: await interrupted })
    await replica.stop()
    await replica.sync()
    log("info", "nodelite shut down")
  } finally {
    await replica.stop()
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
  let log = Logger.make({ stderr: true })
  try {
    const args = parse(argv)
    if (["help", "-h", "--help"].includes(args.command) || args.flags.get("help")) { console.log(help); return }
    if (args.command === "version") {
      if (args.positional.length) throw new Error("usage: ltxjs version")
      console.log(`ltxjs ${version}`)
    } else if (args.command === "replicate" || args.command === "restore") {
      log = Logger.make({
        level: Logger.parseLevel(String(args.flags.get("log-level") ?? (process.env.LOG_LEVEL || "info"))),
        type: Logger.parseFormat(String(args.flags.get("log-format") ?? "text")),
        stderr: args.flags.get("log-stderr") === true
      })
      if (args.command === "replicate") await replicate(args, log)
      else await restore(args, log)
    } else throw new Error(`unsupported command: ${args.command}\nRun ltxjs --help for usage.`)
  } catch (error) {
    log("error", "command failed", { error: error instanceof Error ? error : String(error) })
    throw error
  }
}

if (import.meta.main) {
  try { await main() }
  catch { process.exitCode = 1 }
}
