import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Ltx from "../src/Ltx.ts"
import * as ObjectStore from "../src/ObjectStore.ts"
import * as Replica from "../src/Replica.ts"

const directories:string[]=[]
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})})
const setup=async()=>{const directory=await mkdtemp(join(tmpdir(),"ltx-js-"));directories.push(directory);const path=join(directory,"db.sqlite");const db=new Database(path);db.run("PRAGMA journal_mode=WAL");db.run("PRAGMA wal_autocheckpoint=0");db.run("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");db.run("INSERT INTO items(value) VALUES ('one')");return{directory,path,db}}

describe("Replica",()=>{
  test("snapshots, streams committed WAL transactions, and restores",async()=>{
    const {directory,path,db}=await setup(), store=ObjectStore.memory(), replica=Replica.make({databasePath:path,store,now:()=>new Date("2024-01-01T00:00:00Z")})
    const first=await replica.sync(); expect(first.txId).toBe(1n)
    db.transaction(()=>{db.run("INSERT INTO items(value) VALUES ('two')");db.run("INSERT INTO items(value) VALUES ('three')")})()
    const second=await replica.sync(); expect(second.txId).toBeGreaterThan(1n)
    const keys=[...store.entries().keys()].filter(key=>key.endsWith(".ltx")).sort(); expect(keys.length).toBeGreaterThanOrEqual(2)
    const files=keys.map(key=>Ltx.decode(store.entries().get(key)!)); expect(files[0]!.header.minTxId).toBe(1n); expect(files.every(file=>(file.header.flags&Ltx.NoChecksum)!==0&&file.postApplyChecksum===0n)).toBe(true)
    const restored=join(directory,"restored.sqlite"); const position=await replica.restore(restored); expect(position).toEqual(second)
    const restoredDb=new Database(restored,{readonly:true}); expect(restoredDb.query("SELECT value FROM items ORDER BY id").all()).toEqual([{value:"one"},{value:"two"},{value:"three"}]); restoredDb.close(); db.close()
  })

  test("persists position and does not upload transactions twice after restart",async()=>{
    const {path,db}=await setup(),store=ObjectStore.memory(), first=Replica.make({databasePath:path,store}); await first.sync(); db.run("INSERT INTO items(value) VALUES ('two')"); const position=await first.sync(); const count=store.entries().size
    const restarted=Replica.make({databasePath:path,store}); expect(await restarted.sync()).toEqual(position); expect(store.entries().size).toBe(count); db.close()
  })

  test("serializes concurrent sync calls",async()=>{const {path,db}=await setup(),store=ObjectStore.memory(),replica=Replica.make({databasePath:path,store});const [a,b,c]=await Promise.all([replica.sync(),replica.sync(),replica.sync()]);expect(a).toEqual(b);expect(b).toEqual(c);expect([...store.entries().keys()].filter(key=>key.endsWith(".ltx"))).toHaveLength(1);db.close()})

  test("polls for changes until stopped",async()=>{const {path,db}=await setup(),store=ObjectStore.memory(),replica=Replica.make({databasePath:path,store,interval:5});replica.start();const deadline=Date.now()+1000;while(replica.position().txId===0n&&Date.now()<deadline)await Bun.sleep(5);db.run("INSERT INTO items(value) VALUES ('watched')");while(replica.position().txId===1n&&Date.now()<deadline)await Bun.sleep(5);await replica.stop();expect(replica.position().txId).toBeGreaterThan(1n);db.close()})

  test("logs background sync failures while preserving the error callback", async () => {
    const { path, db } = await setup(), failure = new Error("storage unavailable")
    const logs: Array<{ level: string; message: string; fields: unknown }> = []
    let onError!: (error: unknown) => void
    const failed = new Promise<unknown>(resolve => { onError = resolve })
    const replica = Replica.make({
      databasePath: path,
      store: { ...ObjectStore.memory(), get: async () => { throw failure } },
      interval: 5,
      logger: (level, message, fields) => { logs.push({ level, message, fields }) },
      onError
    })
    try {
      replica.start()
      expect(await failed).toBe(failure)
      await replica.stop()
      expect(logs).toEqual([{ level: "error", message: "sync error", fields: { db: path, error: failure } }])
    } finally { await replica.stop(); db.close() }
  })

  test("rejects restore when an LTX object is corrupted",async()=>{const {directory,path,db}=await setup(),store=ObjectStore.memory(),replica=Replica.make({databasePath:path,store});await replica.sync();const entry=[...store.entries()].find(([key])=>key.endsWith(".ltx"))!;const corrupt=entry[1].slice();corrupt[120]=corrupt[120]!^1;await store.put(entry[0],corrupt);expect(replica.restore(join(directory,"bad.sqlite"))).rejects.toThrow();db.close()})

  for (const failedKey of [".ltx", "state.json"]) {
    test(`retries a failed ${failedKey} upload without advancing position`, async () => {
      const {directory,path,db}=await setup(), memory=ObjectStore.memory()
      let fail=false
      const store:ObjectStore.ObjectStore={...memory,put:async(key,value)=>{
        if(fail&&key.endsWith(failedKey)){fail=false;throw new Error("upload failed")}
        await memory.put(key,value)
      }}
      const replica=Replica.make({databasePath:path,store})
      try {
        const before=await replica.sync()
        db.run("INSERT INTO items(value) VALUES ('retry')")
        fail=true
        await expect(replica.sync()).rejects.toThrow("upload failed")
        expect(replica.position()).toEqual(before)
        const after=await replica.sync()
        expect(after.txId).toBe(before.txId+1n)
        const restarted=Replica.make({databasePath:path,store})
        try { expect(await restarted.sync()).toEqual(after) } finally { await restarted.stop() }
        const output=join(directory,"retry.sqlite")
        expect(await replica.restore(output)).toEqual(after)
        const restored=new Database(output,{readonly:true})
        try { expect(restored.query("SELECT value FROM items ORDER BY id").values()).toEqual([["one"],["retry"]]) }
        finally { restored.close() }
      } finally { await replica.stop();db.close() }
    })
  }

  test("snapshots the current database while another reader blocks checkpoints",async()=>{
    const {directory,path,db}=await setup(),reader=new Database(path)
    reader.run("BEGIN")
    reader.query("SELECT * FROM items").all()
    db.run("INSERT INTO items(value) VALUES ('after reader')")
    const replica=Replica.make({databasePath:path,store:ObjectStore.memory()})
    try {
      const first=await replica.sync()
      expect(first.txId).toBe(1n)
      const output=join(directory,"reader.sqlite")
      expect(await replica.restore(output)).toEqual(first)
      const restored=new Database(output,{readonly:true})
      try { expect(restored.query("SELECT value FROM items ORDER BY id").values()).toEqual([["one"],["after reader"]]) }
      finally { restored.close() }
    } finally { await replica.stop();reader.close();db.close() }
  })

  test("retains writes committed during the initial snapshot upload",async()=>{
    const {directory,path,db}=await setup(),memory=ObjectStore.memory()
    let wrote=false
    const store:ObjectStore.ObjectStore={...memory,put:async(key,value)=>{
      if(!wrote&&key.endsWith(".ltx")){wrote=true;db.run("INSERT INTO items(value) VALUES ('during upload')")}
      await memory.put(key,value)
    }}
    const replica=Replica.make({databasePath:path,store})
    try {
      const position=await replica.sync(),output=join(directory,"during.sqlite")
      expect(position.txId).toBe(2n)
      expect(await replica.restore(output)).toEqual(position)
      const restored=new Database(output,{readonly:true})
      try { expect(restored.query("SELECT value FROM items ORDER BY id").values()).toEqual([["one"],["during upload"]]) }
      finally { restored.close() }
    } finally { await replica.stop();db.close() }
  })

})
