import { Database } from "bun:sqlite"
import * as test from "bun:test"
import * as NFs from "node:fs/promises"
import * as NOs from "node:os"
import * as NPath from "node:path"
import * as Checksum from "../src/Checksum.ts"
import * as FileStore from "../src/FileStore.ts"
import * as Ltx from "../src/Ltx.ts"
import * as ObjectStore from "../src/ObjectStore.ts"
import * as Replica from "../src/Replica.ts"

const directories: string[] = []
test.afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await NFs.rm(directory, { recursive: true, force: true })
  }
})

const image = (db: Database) => {
  const bytes = db.serialize()
  const rawPageSize = new DataView(bytes.buffer, bytes.byteOffset).getUint16(16)
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
  const pages = Array.from({ length: bytes.length / pageSize }, (_, index) => ({
    pageNumber: index + 1,
    data: bytes.subarray(index * pageSize, (index + 1) * pageSize),
  }))
  return {
    pageSize,
    pages,
    checksum: Checksum.database(pages.map((page) => [page.pageNumber, page.data])),
  }
}

const encode = (
  current: ReturnType<typeof image>,
  min: bigint,
  max: bigint,
  previous?: ReturnType<typeof image>,
) =>
  Ltx.encode(
    {
      flags: 0,
      pageSize: current.pageSize,
      commit: current.pages.length,
      minTxId: min,
      maxTxId: max,
      timestamp: 0n,
      preApplyChecksum: previous?.checksum ?? 0n,
      walOffset: 0n,
      walSize: 0n,
      walSalt1: 0,
      walSalt2: 0,
      nodeId: 0n,
    },
    current.pages.filter((page) => !previous?.pages[page.pageNumber - 1]?.data.equals(page.data)),
    current.checksum,
  )

const setup = async () => {
  const directory = await NFs.mkdtemp(NPath.join(NOs.tmpdir(), "ltx-restore-"))
  directories.push(directory)
  const db = new Database(":memory:")
  db.run("CREATE TABLE items(value TEXT)")
  db.run("INSERT INTO items VALUES ('one')")
  return { directory, db, store: ObjectStore.memory() }
}

test.describe("restore planning", () => {
  test.it("restores the newest snapshot when only its final L0 file survives", async () => {
    const fixture = await setup()
    const first = image(fixture.db)
    fixture.db.run("INSERT INTO items VALUES ('two')")
    const latest = image(fixture.db)
    fixture.db.close()
    const prefix = "ltx/adex/db.sqlite3/"
    await fixture.store.put(
      `${prefix}0000/${Ltx.formatFilename(0x58e8n, 0x58e8n)}`,
      encode(latest, 0x58e8n, 0x58e8n, first),
    )
    await fixture.store.put(
      `${prefix}0001/${Ltx.formatFilename(0x58e7n, 0x58e8n)}`,
      encode(latest, 0x58e7n, 0x58e8n, first),
    )
    await fixture.store.put(
      `${prefix}0009/${Ltx.formatFilename(1n, 0x58e0n)}`,
      encode(first, 1n, 0x58e0n),
    )
    const snapshot = `${prefix}0009/${Ltx.formatFilename(1n, 0x58e8n)}`
    await fixture.store.put(snapshot, encode(latest, 1n, 0x58e8n))
    const fetched: string[] = []
    const store = {
      ...fixture.store,
      get: async (key: string) => {
        fetched.push(key)
        return fixture.store.get(key)
      },
    }
    const output = NPath.join(fixture.directory, "restored.sqlite")
    const replica = Replica.make({ databasePath: output, store })
    test.expect(await replica.restore(output)).toEqual({ txId: 0x58e8n, checksum: latest.checksum })
    test.expect(fetched).toEqual([snapshot])
    const restored = new Database(output, { readonly: true })
    try {
      test.expect(restored.query("PRAGMA integrity_check").values()).toEqual([["ok"]])
      test
        .expect(restored.query("SELECT value FROM items ORDER BY rowid").values())
        .toEqual([["one"], ["two"]])
    } finally {
      restored.close()
    }
  })

  test.it("replays overlapping compacted files across levels, then the L0 tail", async () => {
    const fixture = await setup()
    const first = image(fixture.db)
    fixture.db.run("INSERT INTO items VALUES ('two')")
    const second = image(fixture.db)
    fixture.db.run("INSERT INTO items VALUES ('three')")
    const third = image(fixture.db)
    fixture.db.run("INSERT INTO items VALUES ('four')")
    const fourth = image(fixture.db)
    fixture.db.close()
    const snapshot = `ltx/0009/${Ltx.formatFilename(1n, 5n)}`
    const compacted = `ltx/0003/${Ltx.formatFilename(4n, 8n)}`
    const tail = `ltx/0000/${Ltx.formatFilename(9n, 9n)}`
    await fixture.store.put(snapshot, encode(second, 1n, 5n))
    await fixture.store.put(`ltx/0001/${Ltx.formatFilename(6n, 6n)}`, encode(third, 6n, 6n, second))
    await fixture.store.put(compacted, encode(third, 4n, 8n, first))
    await fixture.store.put(tail, encode(fourth, 9n, 9n, third))
    const fetched: string[] = []
    const store = {
      ...fixture.store,
      get: async (key: string) => {
        fetched.push(key)
        return fixture.store.get(key)
      },
    }
    const output = NPath.join(fixture.directory, "restored.sqlite")
    test
      .expect(await Replica.make({ databasePath: output, store }).restore(output))
      .toEqual({ txId: 9n, checksum: fourth.checksum })
    test.expect(fetched).toEqual([snapshot, compacted, tail])
    const restored = new Database(output, { readonly: true })
    try {
      test.expect(restored.query("PRAGMA integrity_check").values()).toEqual([["ok"]])
      test
        .expect(restored.query("SELECT value FROM items ORDER BY rowid").values())
        .toEqual([["one"], ["two"], ["three"], ["four"]])
    } finally {
      restored.close()
    }
  })

  test.it("rejects a gap after the snapshot without publishing a partial restore", async () => {
    const fixture = await setup()
    const current = image(fixture.db)
    fixture.db.close()
    await fixture.store.put(`ltx/0009/${Ltx.formatFilename(1n, 5n)}`, encode(current, 1n, 5n))
    await fixture.store.put(
      `ltx/0000/${Ltx.formatFilename(7n, 7n)}`,
      encode(current, 7n, 7n, current),
    )
    const output = NPath.join(fixture.directory, "restored.sqlite")
    await test
      .expect(Replica.make({ databasePath: output, store: fixture.store }).restore(output))
      .rejects.toThrow("non-contiguous LTX")
    test.expect(await Bun.file(output).exists()).toBe(false)
  })

  test.it("rejects listings containing multiple database replicas", async () => {
    const fixture = await setup()
    const current = image(fixture.db)
    fixture.db.close()
    for (const name of ["first", "second"]) {
      await fixture.store.put(
        `ltx/${name}/0009/${Ltx.formatFilename(1n, 5n)}`,
        encode(current, 1n, 5n),
      )
    }
    const output = NPath.join(fixture.directory, "restored.sqlite")
    await test
      .expect(Replica.make({ databasePath: output, store: fixture.store }).restore(output))
      .rejects.toThrow("multiple LTX replicas")
    test.expect(await Bun.file(output).exists()).toBe(false)
  })

  test.it("rejects a selected file whose header does not match its filename", async () => {
    const fixture = await setup()
    const current = image(fixture.db)
    fixture.db.close()
    await fixture.store.put(`ltx/0009/${Ltx.formatFilename(1n, 5n)}`, encode(current, 1n, 4n))
    const output = NPath.join(fixture.directory, "restored.sqlite")
    await test
      .expect(Replica.make({ databasePath: output, store: fixture.store }).restore(output))
      .rejects.toThrow("filename/header transaction range mismatch")
    test.expect(await Bun.file(output).exists()).toBe(false)
  })

  for (const prefix of ["", "adex/db.sqlite3"]) {
    test.it(
      `restores a compacted backup through the CLI with prefix ${JSON.stringify(prefix)}`,
      async () => {
        const fixture = await setup()
        const current = image(fixture.db)
        fixture.db.close()
        const directory = NPath.join(fixture.directory, "backup")
        const store = FileStore.make(directory)
        await store.put(
          `adex/db.sqlite3/0000/${Ltx.formatFilename(0x58e8n, 0x58e8n)}`,
          encode(current, 0x58e8n, 0x58e8n, current),
        )
        await store.put(
          `adex/db.sqlite3/0009/${Ltx.formatFilename(1n, 0x58e8n)}`,
          encode(current, 1n, 0x58e8n),
        )
        const output = NPath.join(fixture.directory, "restored.sqlite")
        const child = Bun.spawn(
          [
            process.execPath,
            new URL("../src/Cli.ts", import.meta.url).pathname,
            "restore",
            "-log-format=json",
            "-o",
            output,
            NPath.join(directory, prefix),
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        test
          .expect({ code: await child.exited, stderr })
          .toEqual({ code: 0, stderr: "" })
        test.expect(JSON.parse(stdout)).toMatchObject({ level: "INFO", msg: "restore completed", path: output, txid: "00000000000058e8" })
        const restored = new Database(output, { readonly: true })
        try {
          test.expect(restored.query("PRAGMA integrity_check").values()).toEqual([["ok"]])
          test.expect(restored.query("SELECT value FROM items").values()).toEqual([["one"]])
        } finally {
          restored.close()
        }
      },
    )
  }
})
