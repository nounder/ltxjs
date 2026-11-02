import { afterEach,describe,expect,test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp,rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ObjectStore from "../src/ObjectStore.ts"
import * as Replica from "../src/Replica.ts"

const directories:string[]=[];afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})})
const random=()=>{let state=0x6d2b79f5;return()=>{state=Math.imul(state^(state>>>15),state|1);state^=state+Math.imul(state^(state>>>7),state|61);return((state^(state>>>14))>>>0)/4294967296}}

describe("replication stress",()=>{
  test("survives randomized commits, rollbacks, WAL resets, and replica restarts",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"ltx-js-stress-"));directories.push(directory);const source=join(directory,"source.sqlite"),output=join(directory,"restored.sqlite"),store=ObjectStore.memory(),rng=random();let db=new Database(source);db.run("PRAGMA journal_mode=WAL");db.run("PRAGMA wal_autocheckpoint=0");db.run("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL)");let replica=Replica.make({databasePath:source,store});await replica.sync()
    for(let transaction=1;transaction<=100;transaction++){
      const rollback=transaction%13===0;try{db.transaction(()=>{for(let operation=0;operation<12;operation++){const choice=rng();if(choice<.5)db.run("INSERT INTO records(value,revision) VALUES (?,?)",[`value-${transaction}-${operation}`,transaction]);else if(choice<.8)db.run("UPDATE records SET value=value || '-u',revision=? WHERE id=(SELECT id FROM records ORDER BY id LIMIT 1 OFFSET ?)",[transaction,Math.floor(rng()*20)]);else db.run("DELETE FROM records WHERE id=(SELECT id FROM records ORDER BY id LIMIT 1 OFFSET ?)",[Math.floor(rng()*20)])}if(rollback)throw new Error("rollback")})()}catch(error){if(!rollback)throw error}
      const before=replica.position();const after=await replica.sync();if(rollback)expect(after).toEqual(before)
      if(transaction%20===0){await replica.stop();replica=Replica.make({databasePath:source,store});expect(await replica.sync()).toEqual(after)}
      if(transaction%25===0)db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      if(transaction===50){db.close();db=new Database(source);db.run("PRAGMA journal_mode=WAL");db.run("PRAGMA wal_autocheckpoint=0")}
    }
    const expected=db.query("SELECT id,value,revision FROM records ORDER BY id").all(),position=await replica.sync();db.close();expect((await replica.restore(output)).txId).toBe(position.txId);await replica.stop()
    const restored=new Database(output,{readonly:true});expect(restored.query("PRAGMA integrity_check").values()[0]![0]).toBe("ok");expect(restored.query("SELECT id,value,revision FROM records ORDER BY id").all()).toEqual(expected);restored.close()
  })

  test("prevents aggressive auto-checkpoints from recycling unsynced WAL pages",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"ltx-js-checkpoint-"));directories.push(directory);const source=join(directory,"source.sqlite"),output=join(directory,"restored.sqlite"),store=ObjectStore.memory(),db=new Database(source);db.run("PRAGMA journal_mode=WAL");db.run("PRAGMA wal_autocheckpoint=1");db.run("CREATE TABLE pages(id INTEGER PRIMARY KEY,payload BLOB)");const replica=Replica.make({databasePath:source,store});await replica.sync()
    const insert=db.prepare("INSERT INTO pages(payload) VALUES (?)");for(let transaction=0;transaction<40;transaction++)db.transaction(()=>{for(let row=0;row<20;row++)insert.run(new Uint8Array(2_000).fill(transaction))})()
    const expected=db.query("SELECT id,hex(payload) payload FROM pages ORDER BY id").all();await replica.sync();await replica.restore(output);const restored=new Database(output,{readonly:true});expect(restored.query("PRAGMA integrity_check").values()[0]![0]).toBe("ok");expect(restored.query("SELECT id,hex(payload) payload FROM pages ORDER BY id").all()).toEqual(expected);restored.close();db.close();await replica.stop()
  },20_000)
})
