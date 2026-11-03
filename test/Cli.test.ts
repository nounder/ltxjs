import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as FileStore from "../src/FileStore.ts"

const cli = new URL("../src/Cli.ts", import.meta.url).pathname
const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ltx-cli-")); directories.push(directory)
  const source = join(directory, "source.sqlite"), destination = join(directory, "backup"), output = join(directory, "restored.sqlite")
  const db = new Database(source)
  db.run("PRAGMA journal_mode=WAL")
  db.run("CREATE TABLE items(value TEXT)")
  db.run("INSERT INTO items VALUES ('one')")
  return { directory, source, destination, output, db }
}
const run = async (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe", env })
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, stdout, stderr }
  } finally { clearTimeout(timeout) }
}
const rows = (path: string) => {
  const db = new Database(path, { readonly: true })
  try { expect(db.query("PRAGMA integrity_check").values()).toEqual([["ok"]]); return db.query("SELECT value FROM items ORDER BY rowid").values() }
  finally { db.close() }
}
const records = (output: string) => output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))

describe("CLI", () => {
  test("prints help and version; rejects unknown and unsupported options", async () => {
    expect((await run(["--help"])).stdout).toContain("replicate [-once]")
    expect((await run(["version"])).stdout).toBe("ltxjs 0.1.0\n")
    for (const args of [["missing"], ["replicate", "-config", "x.yml"], ["restore", "-timestamp", "2024-01-01"], ["replicate"], ["restore", "file:///tmp/x"]]) {
      expect((await run(args)).code).toBe(1)
    }
  })

  test("replicates once to a file URL and restores to a new path", async () => {
    const { source, destination, output, db } = await setup(), url = pathToFileURL(destination).href
    try {
      expect(await run(["replicate", "-once", source, url])).toMatchObject({ code: 0 })
      expect(await readdir(join(destination, "0000"))).toEqual(["0000000000000001-0000000000000001.ltx"])
      expect(await run(["restore", "-o", output, url])).toMatchObject({ code: 0 })
      expect(rows(output)).toEqual([["one"]])
    } finally { db.close() }
  })

  test("writes Litestream JSON logs and filters CLI and library events", async () => {
    const { source, destination, output, db } = await setup()
    try {
      const env = { ...process.env, LOG_LEVEL: "error" }
      const replication = await run(["replicate", "-once", "--log-format=json", "-log-level", "DEBUG", source, destination], env)
      expect(replication).toMatchObject({ code: 0, stderr: "" })
      const logs = records(replication.stdout)
      expect(logs.map(log => log.msg)).toEqual(["nodelite", "ltx file uploaded", "initialized db", "replica sync", "replicating to", "one-shot replication complete"])
      expect(logs.every(log => !Number.isNaN(Date.parse(log.time)) && ["INFO", "DEBUG"].includes(log.level))).toBe(true)
      expect(logs.find(log => log.msg === "ltx file uploaded")).toMatchObject({ db: source, level: "DEBUG", ltx_level: 0, minTXID: "0000000000000001", maxTXID: "0000000000000001" })
      expect((await run(["replicate", "-once", source, destination], env))).toMatchObject({ code: 0, stdout: "", stderr: "" })
      const restoration = await run(["restore", "-log-format", "json", "--log-stderr", "-o", output, destination])
      expect(restoration).toMatchObject({ code: 0, stdout: "" })
      expect(records(restoration.stderr)).toEqual([expect.objectContaining({ level: "INFO", msg: "restore completed", path: output, txid: "0000000000000001" })])
    } finally { db.close() }
  })

  test("rejects invalid logging options and writes structured command failures", async () => {
    for (const args of [["replicate", "-log-level", "verbose"], ["restore", "-log-format=xml"], ["replicate", "-log-level"], ["restore", "-log-format"], ["replicate", "-log-stderr=maybe"]]) {
      const result = await run(args)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("level=ERROR")
    }
    const result = await run(["replicate", "-log-format=json", "-log-stderr", "/missing.sqlite", "./backup"])
    expect(result).toMatchObject({ code: 1, stdout: "" })
    expect(records(result.stderr)).toEqual([expect.objectContaining({ level: "ERROR", msg: "command failed", error: "database does not exist: /missing.sqlite" })])
  })

  test("resumes one-shot replication after a writer closes and checkpoints the WAL", async () => {
    const { source, destination, output, db } = await setup()
    db.close()
    expect((await run(["replicate", "--once", source, destination])).code).toBe(0)
    const writer = new Database(source)
    writer.run("INSERT INTO items VALUES ('two')")
    writer.close()
    expect((await run(["replicate", "-once=true", source, destination])).code).toBe(0)
    expect((await run(["restore", "-o", output, destination])).code).toBe(0)
    expect(rows(output)).toEqual([["one"], ["two"]])
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`flushes pending writes on ${signal}`, async () => {
      const { source, destination, output, db } = await setup()
      const child = Bun.spawn([process.execPath, cli, "replicate", source, destination], { stdout: "pipe", stderr: "pipe" })
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
      try {
        const reader = child.stdout.getReader(), decoder = new TextDecoder()
        let logs = ""
        try {
          while (!logs.includes('msg="replicating to"')) {
            const chunk = await reader.read()
            if (chunk.done) break
            logs += decoder.decode(chunk.value, { stream: true })
          }
        } finally { reader.releaseLock() }
        expect(logs).toContain('msg="replicating to"')
        db.run("INSERT INTO items VALUES ('at shutdown')")
        child.kill(signal)
        expect(await child.exited).toBe(0)
        const shutdownReader = child.stdout.getReader()
        let shutdown = ""
        try {
          while (true) {
            const chunk = await shutdownReader.read()
            if (chunk.done) break
            shutdown += decoder.decode(chunk.value, { stream: true })
          }
        } finally { shutdownReader.releaseLock() }
        expect(shutdown).toContain(`signal=${signal}`)
        expect(shutdown).toContain('msg="nodelite shut down"')
        expect((await run(["restore", "-o", output, destination])).code).toBe(0)
        expect(rows(output)).toEqual([["one"], ["at shutdown"]])
      } finally { clearTimeout(timeout); child.kill(); await child.exited; db.close() }
    })
  }

  test("protects existing output and SQLite sidecars, and supports conditional restores", async () => {
    const { source, destination, output, db } = await setup()
    try {
      expect((await run(["replicate", "-once", source, destination])).code).toBe(0)
      await writeFile(output, "keep me")
      expect((await run(["restore", "-o", output, destination])).code).toBe(1)
      expect((await run(["restore", "-if-db-not-exists", "-o", output, destination])).code).toBe(0)
      expect(await readFile(output, "utf8")).toBe("keep me")
      await rm(output)
      await writeFile(`${output}-wal`, "keep sidecar")
      expect((await run(["restore", "-o", output, destination])).code).toBe(1)
      expect(await readFile(`${output}-wal`, "utf8")).toBe("keep sidecar")
      await rm(`${output}-wal`)
      expect((await run(["restore", "-if-replica-exists", "-o", output, `${destination}-empty`])).code).toBe(0)
      expect(await Bun.file(output).exists()).toBe(false)
      expect((await run(["restore", "-o", output, `${destination}-empty`])).code).toBe(1)
      expect((await run(["replicate", "-once", `${source}-missing`, destination])).code).toBe(1)
      expect(await Bun.file(`${source}-missing`).exists()).toBe(false)
    } finally { db.close() }
  })

  test("replicates and restores through the S3 CLI environment", async () => {
    const { source, output, db } = await setup(), objects = new Map<string, Uint8Array>()
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
      const url = new URL(request.url), key = url.pathname
      if (!request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=cli-test/")) return new Response("invalid credentials", { status: 403 })
      if (request.headers.get("x-amz-security-token") !== "session") return new Response("missing session token", { status: 403 })
      if (request.method === "PUT") { objects.set(key, new Uint8Array(await request.arrayBuffer())); return new Response(null) }
      if (url.searchParams.has("list-type")) {
        const prefix = `/bucket/${url.searchParams.get("prefix")}`
        const contents = [...objects].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => `<Contents><Key>${name.slice("/bucket/".length)}</Key><Size>${value.length}</Size></Contents>`).join("")
        return new Response(`<ListBucketResult>${contents}</ListBucketResult>`)
      }
      const value = objects.get(key)
      return value ? new Response(new Uint8Array(value)) : new Response(null, { status: 404 })
    } })
    const env = { ...process.env, AWS_ACCESS_KEY_ID: "cli-test", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_SESSION_TOKEN: "session", AWS_ENDPOINT_URL_S3: server.url.href, AWS_REGION: "us-east-1" }
    try {
      expect(await run(["replicate", "-once", source, "s3://bucket/db"], env)).toMatchObject({ code: 0 })
      expect(objects.has("/bucket/db/0000/0000000000000001-0000000000000001.ltx")).toBe(true)
      expect(await run(["restore", "-o", output, "s3://bucket/db"], env)).toMatchObject({ code: 0 })
      expect(rows(output)).toEqual([["one"]])
      const failed = await run(["restore", "-if-replica-exists", "-o", `${output}-failed`, "s3://bucket/db"], { ...env, AWS_ACCESS_KEY_ID: "bad" })
      expect(failed.code).toBe(1)
      expect(failed.stdout).toContain("403")
      expect(failed.stdout).not.toContain("test-secret")
    } finally { server.stop(true); db.close() }
  })
})

describe("file object storage", () => {
  test("copies bytes, lists by prefix, removes objects, and rejects traversal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ltx-file-")); directories.push(directory)
    const store = FileStore.make(join(directory, "backup")), input = Uint8Array.of(1, 2)
    expect(await store.list("")).toEqual([])
    await store.put("db/a", input); input[0] = 9
    await store.put("db-other/b", Uint8Array.of(3))
    expect(await store.get("db/a")).toEqual(Uint8Array.of(1, 2))
    expect((await store.list("db/")).map(info => [info.key, info.size])).toEqual([["db/a", 2]])
    await store.remove("db/a")
    expect(await store.get("db/a")).toBeUndefined()
    await expect(store.put("../outside", input)).rejects.toThrow("invalid object key")
  })
})
