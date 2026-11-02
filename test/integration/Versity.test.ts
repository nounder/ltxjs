import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Ltx from "../../src/Ltx.ts"
import * as ObjectStore from "../../src/ObjectStore.ts"
import * as Replica from "../../src/Replica.ts"
import * as S3 from "../../src/S3.ts"

const enabled=Bun.env.TEST_INTEGRATIONS==="1", directory=enabled?await mkdtemp(join(tmpdir(),"ltx-js-versity-")):""
const s3:S3.Options={endpoint:process.env.LTX_JS_S3_ENDPOINT??"http://127.0.0.1:7070",bucket:process.env.LTX_JS_S3_BUCKET??"ltx-js-test",region:"us-east-1",accessKeyId:process.env.AWS_ACCESS_KEY_ID??"ltx-js",secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY??"ltx-js-development-secret",pathStyle:true}
const awsEnvironment={...process.env,AWS_ACCESS_KEY_ID:s3.accessKeyId,AWS_SECRET_ACCESS_KEY:s3.secretAccessKey}
const command=async(args:ReadonlyArray<string>)=>{const child=Bun.spawn([...args],{stdout:"pipe",stderr:"pipe",env:awsEnvironment}),[code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);if(code!==0)throw new Error(`${args.join(" ")} failed: ${stderr}`)}

describe.skipIf(!enabled)("VersityGW integration",()=>{
  beforeAll(async()=>S3.createBucket(s3)); afterAll(async()=>rm(directory,{recursive:true,force:true}))
  test("replicates SQLite through real S3 HTTP and restores it",async()=>{
    const source=join(directory,"source.sqlite"),output=join(directory,"output.sqlite"),db=new Database(source);db.run("PRAGMA journal_mode=WAL");db.run("PRAGMA wal_autocheckpoint=0");db.run("CREATE TABLE data(value TEXT)");db.run("INSERT INTO data VALUES ('snapshot')")
    const replica=Replica.make({databasePath:source,store:S3.make({...s3,prefix:`runs/${crypto.randomUUID()}`})});await replica.sync();db.run("INSERT INTO data VALUES ('wal')");const expected=await replica.sync();expect(await replica.restore(output)).toEqual(expected)
    const restored=new Database(output,{readonly:true});expect(restored.query("SELECT value FROM data ORDER BY rowid").values()).toEqual([["snapshot"],["wal"]]);restored.close();db.close();await replica.stop()
  })
  test.skipIf(!Bun.which("litestream"))("produces LTX files restorable by Go Litestream",async()=>{
    const source=join(directory,"go-source.sqlite"),output=join(directory,"go-restored.sqlite"),config=join(directory,"litestream.yml"),id=`compat/${crypto.randomUUID()}`,db=new Database(source);db.run("PRAGMA journal_mode=WAL");db.run("PRAGMA wal_autocheckpoint=0");db.run("CREATE TABLE compatible(id INTEGER PRIMARY KEY,value TEXT)");db.run("INSERT INTO compatible(value) VALUES ('snapshot')");const replica=Replica.make({databasePath:source,store:S3.make({...s3,prefix:id})});await replica.sync()
    for(let batch=0;batch<12;batch++){db.transaction(()=>{for(let index=0;index<25;index++)db.run("INSERT INTO compatible(value) VALUES (?)",[`batch-${batch}-${index}`]);if(batch%3===0)db.run("UPDATE compatible SET value=value || '-u' WHERE id%11=0");if(batch%4===0)db.run("DELETE FROM compatible WHERE id%17=0")})();await replica.sync()}
    const expected=db.query("SELECT id,value FROM compatible ORDER BY id").all();db.close();await replica.stop()
    await Bun.write(config,`dbs:\n  - path: ${JSON.stringify(source)}\n    replica:\n      type: s3\n      bucket: ${s3.bucket}\n      path: ${id}/ltx\n      endpoint: ${s3.endpoint}\n      region: us-east-1\n      force-path-style: true\n      sign-payload: true\n      require-content-md5: false\n`)
    await command([Bun.which("litestream")!,"restore","-config",config,"-o",output,source]);const restored=new Database(output,{readonly:true});expect(restored.query("PRAGMA integrity_check").values()[0]![0]).toBe("ok");expect(restored.query("SELECT id,value FROM compatible ORDER BY id").all()).toEqual(expected);restored.close()
  })
  test.skipIf(!Bun.which("litestream"))("decodes and restores an upstream Go Litestream snapshot",async()=>{
    const source=join(directory,"upstream-source.sqlite"),output=join(directory,"upstream-restored.sqlite"),config=join(directory,"upstream.yml"),id=`upstream/${crypto.randomUUID()}`,db=new Database(source);db.run("CREATE TABLE upstream(id INTEGER PRIMARY KEY,value BLOB)");const insert=db.prepare("INSERT INTO upstream(value) VALUES (?)"),write=db.transaction(()=>{for(let index=0;index<500;index++)insert.run(new Uint8Array(200).fill(index&255))});write();const expected=db.query("SELECT id,hex(value) value FROM upstream ORDER BY id").all();db.close()
    await Bun.write(config,`dbs:\n  - path: ${JSON.stringify(source)}\n    replica:\n      type: s3\n      bucket: ${s3.bucket}\n      path: ${id}\n      endpoint: ${s3.endpoint}\n      region: us-east-1\n      force-path-style: true\n      sign-payload: true\n      require-content-md5: false\n`);await command([Bun.which("litestream")!,"replicate","-once","-force-snapshot","-config",config])
    const remote=S3.make(s3),infos=(await remote.list(id)).filter(info=>info.key.endsWith(".ltx")),decoded=await Promise.all(infos.map(async info=>Ltx.decode((await remote.get(info.key))!)));expect(decoded.length).toBeGreaterThan(0);expect(decoded.every(file=>file.header.pageSize===4096&&file.pages.length>0)).toBe(true)
    const snapshotIndex=infos.findIndex(info=>info.key.includes("/0009/")),index=snapshotIndex>=0?snapshotIndex:decoded.findIndex(file=>file.header.minTxId===1n);expect(index).toBeGreaterThanOrEqual(0);const memory=ObjectStore.memory(),snapshot=decoded[index]!,filename=Ltx.formatFilename(snapshot.header.minTxId,snapshot.header.maxTxId);await memory.put(`ltx/0000/${filename}`,(await remote.get(infos[index]!.key))!);await Replica.make({databasePath:source,store:memory}).restore(output)
    const restored=new Database(output,{readonly:true});expect(restored.query("PRAGMA integrity_check").values()[0]![0]).toBe("ok");expect(restored.query("SELECT id,hex(value) value FROM upstream ORDER BY id").all()).toEqual(expected);restored.close()
  })
})
