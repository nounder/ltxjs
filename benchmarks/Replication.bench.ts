import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Replica from "../src/Replica.ts"
import * as S3 from "../src/S3.ts"

const litestream=Bun.which("litestream")
if(!litestream)throw new Error("litestream is required on PATH")
const endpoint=process.env.LTX_JS_S3_ENDPOINT??"http://127.0.0.1:7070",bucket=process.env.LTX_JS_S3_BUCKET??"ltx-js-bench",accessKeyId=process.env.AWS_ACCESS_KEY_ID??"ltx-js",secretAccessKey=process.env.AWS_SECRET_ACCESS_KEY??"ltx-js-development-secret"
const s3:S3.Options={endpoint,bucket,region:"us-east-1",accessKeyId,secretAccessKey,pathStyle:true},iterations=Number(process.env.BENCH_ITERATIONS??10),rowsPerTransaction=Number(process.env.BENCH_ROWS??1_000),environment={...process.env,AWS_ACCESS_KEY_ID:accessKeyId,AWS_SECRET_ACCESS_KEY:secretAccessKey}
const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds))
const percentile=(values:ReadonlyArray<number>,fraction:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)]!}
const summarize=(values:ReadonlyArray<number>)=>({medianMs:Number(percentile(values,.5).toFixed(2)),p95Ms:Number(percentile(values,.95).toFixed(2)),minMs:Number(Math.min(...values).toFixed(2)),maxMs:Number(Math.max(...values).toFixed(2)),samplesMs:values.map(value=>Number(value.toFixed(2)))})
const createDatabase=(path:string):Database=>{const db=new Database(path);db.run("PRAGMA journal_mode=WAL");db.run("PRAGMA wal_autocheckpoint=0");db.run("CREATE TABLE events(id INTEGER PRIMARY KEY, batch INTEGER NOT NULL, value TEXT NOT NULL)");return db}
const writeBatch=(db:Database,batch:number)=>db.transaction(()=>{const insert=db.prepare("INSERT INTO events(batch,value) VALUES (?,?)");for(let index=0;index<rowsPerTransaction;index++)insert.run(batch,`event-${batch}-${index}`);if(batch>1)db.run("UPDATE events SET value=value || '-updated' WHERE batch=? AND id%17=0",[batch-1]);if(batch>2)db.run("DELETE FROM events WHERE batch=? AND id%29=0",[batch-2])})()
const fingerprint=(path:string):string=>{const db=new Database(path,{readonly:true});try{return JSON.stringify(db.query("SELECT id,batch,value FROM events ORDER BY id").all())}finally{db.close()}}
const command=async(args:ReadonlyArray<string>):Promise<string>=>{const child=Bun.spawn([...args],{stdout:"pipe",stderr:"pipe",env:environment}),[code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code!==0)throw new Error(`${args.join(" ")} failed (${code}): ${stderr}`);return stdout}

await S3.createBucket(s3)
const directory=await mkdtemp(join(tmpdir(),"ltx-js-bench-")),id=crypto.randomUUID(),jsPrefix=`bench/${id}/ltx-js`,goPrefix=`bench/${id}/litestream`,jsPath=join(directory,"ltx-js.sqlite"),goPath=join(directory,"litestream.sqlite"),socket=join(directory,"litestream.sock"),config=join(directory,"litestream.yml")
const jsDb=createDatabase(jsPath),goDb=createDatabase(goPath),store=S3.make(s3),jsReplica=Replica.make({databasePath:jsPath,store:S3.make({...s3,prefix:jsPrefix})})
await Bun.write(config,`sync-interval: 1h\nsocket:\n  enabled: true\n  path: ${socket}\ndbs:\n  - path: ${JSON.stringify(goPath)}\n    replica:\n      type: s3\n      bucket: ${bucket}\n      path: ${goPrefix}\n      endpoint: ${endpoint}\n      region: us-east-1\n      force-path-style: true\n      sign-payload: true\n      require-content-md5: false\n`)
const daemon=Bun.spawn([litestream,"replicate","-config",config,"-log-level","error"],{stdout:"ignore",stderr:"inherit",env:environment})
try {
  const deadline=Date.now()+15_000;let ready=false;while(Date.now()<deadline){const probe=Bun.spawnSync([litestream,"info","-socket",socket],{stdout:"ignore",stderr:"ignore",env:environment});if(probe.exitCode===0){ready=true;break}await sleep(20)}if(!ready)throw new Error("Litestream daemon control socket did not become ready")
  await jsReplica.sync();await command([litestream,"sync","-socket",socket,"-wait",goPath])
  const results={"ltx-js":[] as number[],litestream:[] as number[]}
  for(let batch=1;batch<=iterations;batch++){writeBatch(jsDb,batch);writeBatch(goDb,batch)
    const runJs=async()=>{const start=performance.now();await jsReplica.sync();results["ltx-js"].push(performance.now()-start)},runGo=async()=>{const start=performance.now();await command([litestream!,"sync","-socket",socket,"-wait",goPath]);results.litestream.push(performance.now()-start)}
    if(batch%2===0){await runGo();await runJs()}else{await runJs();await runGo()}
  }
  daemon.kill("SIGTERM");await daemon.exited;jsDb.close();goDb.close()
  const jsOutput=join(directory,"ltx-js-restored.sqlite"),goOutput=join(directory,"litestream-restored.sqlite");await jsReplica.restore(jsOutput);await jsReplica.stop();await command([litestream,"restore","-config",config,"-o",goOutput,goPath])
  const expected=fingerprint(jsPath),jsRestored=fingerprint(jsOutput),goRestored=fingerprint(goOutput);if(expected!==fingerprint(goPath)||expected!==jsRestored||expected!==goRestored)throw new Error("restored database content differs between implementations")
  const jsObjects=await store.list(jsPrefix),goObjects=await store.list(goPrefix)
  console.log(JSON.stringify({methodology:"warmed replicas; identical committed WAL batches; explicit sync-to-remote; alternating execution order; restored content verified",workload:{iterations,rowsPerTransaction,finalRows:JSON.parse(expected).length},"ltx-js":{...summarize(results["ltx-js"]),objects:jsObjects.length,uploadedBytes:jsObjects.reduce((sum,item)=>sum+item.size,0)},litestream:{...summarize(results.litestream),objects:goObjects.length,uploadedBytes:goObjects.reduce((sum,item)=>sum+item.size,0),note:"includes litestream sync CLI/control-socket round trip"},verification:{sourceDatabasesEqual:true,ltxJsRestoreEqual:true,litestreamRestoreEqual:true}},null,2))
} finally {if(daemon.exitCode===null){daemon.kill("SIGTERM");await daemon.exited}try{jsDb.close()}catch{}try{goDb.close()}catch{}await rm(directory,{recursive:true,force:true})}
