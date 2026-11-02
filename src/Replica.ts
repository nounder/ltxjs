import { Database } from "bun:sqlite"
import { rename, rm } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import * as Checksum from "./Checksum.ts"
import * as Ltx from "./Ltx.ts"
import * as Wal from "./Wal.ts"
import type { ObjectStore } from "./ObjectStore.ts"

export interface Options {
  readonly databasePath: string
  readonly store: ObjectStore
  readonly interval?: number
  readonly keyPrefix?: string
  readonly now?: () => Date
  readonly onError?: (error: unknown) => void
}
export interface Position { readonly txId: bigint; readonly checksum: bigint }
export interface Replica {
  readonly sync: () => Promise<Position>
  readonly restore: (outputPath: string) => Promise<Position>
  readonly start: () => void
  readonly stop: () => Promise<void>
  readonly position: () => Position
}

interface State {
  txId: bigint; checksum: bigint; walOffset: number; walSalt1: number; walSalt2: number
  pageSize: number; commit: number; pageChecksums: Map<number,bigint>
}
const initialState = (): State => ({txId:0n,checksum:0n,walOffset:Wal.HeaderSize,walSalt1:0,walSalt2:0,pageSize:0,commit:0,pageChecksums:new Map()})
const normalize = (value="") => value.replace(/^\/+|\/+$/g,"")
const join = (...parts: ReadonlyArray<string>) => parts.map(normalize).filter(Boolean).join("/")
const ltxKey = (base:string,min:bigint,max:bigint) => join(base,"ltx","0000",Ltx.formatFilename(min,max))
const stateKey = (base:string) => join(base,"state.json")

const readDatabase = (bytes:Uint8Array): {pageSize:number; pages:ReadonlyArray<Ltx.Page>} => {
  if (bytes.length < 100 || new TextDecoder().decode(bytes.subarray(0,16)) !== "SQLite format 3\0") throw new Error("invalid SQLite database")
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), raw=view.getUint16(16,false), pageSize=raw===1?65536:raw
  if (bytes.length % pageSize !== 0) throw new Error("database size is not page aligned")
  return {pageSize,pages:Object.freeze(Array.from({length:bytes.length/pageSize},(_,index)=>Object.freeze({pageNumber:index+1,data:bytes.slice(index*pageSize,(index+1)*pageSize)})))}
}

const serializeState = (state:State): Uint8Array => new TextEncoder().encode(JSON.stringify({txId:Ltx.formatTxId(state.txId),checksum:Checksum.format(state.checksum),walOffset:state.walOffset,walSalt1:state.walSalt1,walSalt2:state.walSalt2,pageSize:state.pageSize,commit:state.commit,pageChecksums:[...state.pageChecksums].map(([page,value])=>[page,Checksum.format(value)])}))
const parseState = (value:Uint8Array): State => {
  const data=JSON.parse(new TextDecoder().decode(value)) as {txId:string;checksum:string;walOffset:number;walSalt1:number;walSalt2:number;pageSize:number;commit:number;pageChecksums:Array<[number,string]>}
  return {txId:BigInt(`0x${data.txId}`),checksum:BigInt(`0x${data.checksum}`),walOffset:data.walOffset,walSalt1:data.walSalt1,walSalt2:data.walSalt2,pageSize:data.pageSize,commit:data.commit,pageChecksums:new Map(data.pageChecksums.map(([page,sum])=>[page,BigInt(`0x${sum}`)]))}
}

export const make = (options:Options): Replica => {
  const base=normalize(options.keyPrefix), now=options.now ?? (()=>new Date())
  let state=initialState(), loaded=false, timer:ReturnType<typeof setTimeout>|undefined, active:Promise<Position>|undefined, guard:Database|undefined, stopped=true
  const save = async (next:State) => { await options.store.put(stateKey(base),serializeState(next)); state=next }
  const load = async () => { if(loaded)return; const value=await options.store.get(stateKey(base)); if(value) state=parseState(value); loaded=true }
  const ensureGuard = () => { if(guard)return;guard=new Database(options.databasePath,{readonly:true});guard.run("BEGIN");guard.query("SELECT rootpage FROM sqlite_schema LIMIT 1").get() }
  const closeGuard = () => { if(!guard)return;try{guard.run("COMMIT")}finally{guard.close();guard=undefined} }

  const snapshot = async (): Promise<void> => {
    // Hold the writer lock while capturing both the SQLite snapshot and its WAL
    // cursor. Keep a reader open before releasing it so unsynced frames survive.
    const sqlite=new Database(options.databasePath)
    let db:ReturnType<typeof readDatabase>, wal:Wal.ParseResult|undefined
    try {
      sqlite.run("PRAGMA journal_mode=WAL")
      sqlite.run("BEGIN IMMEDIATE")
      ensureGuard()
      db=readDatabase(sqlite.serialize())
      const walPath=`${options.databasePath}-wal`
      if(existsSync(walPath)) {
        const bytes=readFileSync(walPath)
        if(bytes.length>=Wal.HeaderSize)wal=Wal.parse(bytes)
      }
      sqlite.run("COMMIT")
    } finally { sqlite.close() }
    const snapshotPages=db.pages.filter(page=>page.pageNumber!==Ltx.lockPageNumber(db.pageSize)),pages=snapshotPages.map(page=>[page.pageNumber,page.data] as const), checksum=Checksum.database(pages)
    const header:Ltx.Header={flags:Ltx.NoChecksum,pageSize:db.pageSize,commit:db.pages.length,minTxId:1n,maxTxId:1n,timestamp:BigInt(now().getTime()),preApplyChecksum:0n,walOffset:0n,walSize:0n,walSalt1:0,walSalt2:0,nodeId:0n}
    await options.store.put(ltxKey(base,1n,1n),Ltx.encode(header,snapshotPages,0n))
    await save({txId:1n,checksum,walOffset:wal?.nextOffset??Wal.HeaderSize,walSalt1:wal?.header.salt1??0,walSalt2:wal?.header.salt2??0,pageSize:db.pageSize,commit:db.pages.length,pageChecksums:new Map(pages.map(([page,data])=>[page,Checksum.page(page,data)]))})
  }

  const syncWal = async (): Promise<void> => {
    const file=Bun.file(`${options.databasePath}-wal`); if(!(await file.exists()) || file.size < Wal.HeaderSize)return
    const parsed=Wal.parse(new Uint8Array(await file.arrayBuffer())), same=parsed.header.salt1===state.walSalt1&&parsed.header.salt2===state.walSalt2
    const cursor=same?state.walOffset:Wal.HeaderSize
    for(const transaction of parsed.transactions.filter(value=>value.endOffset>cursor&&value.startOffset>=cursor)) {
      const next:State={...state,pageChecksums:new Map(state.pageChecksums)}
      const min=next.txId+1n, pages=Wal.transactionPages(transaction).map(([pageNumber,data])=>Object.freeze({pageNumber,data}))
      for(const page of pages) { const old=next.pageChecksums.get(page.pageNumber)??0n, sum=Checksum.page(page.pageNumber,page.data); next.checksum=Checksum.Flag|(next.checksum^old^sum); next.pageChecksums.set(page.pageNumber,sum) }
      for(const page of [...next.pageChecksums.keys()]) if(page>transaction.commit) { next.checksum=Checksum.Flag|(next.checksum^next.pageChecksums.get(page)!); next.pageChecksums.delete(page) }
      next.txId=min; next.commit=transaction.commit; next.pageSize=parsed.header.pageSize
      const header:Ltx.Header={flags:Ltx.NoChecksum,pageSize:next.pageSize,commit:transaction.commit,minTxId:min,maxTxId:min,timestamp:BigInt(now().getTime()),preApplyChecksum:0n,walOffset:BigInt(transaction.startOffset),walSize:BigInt(transaction.endOffset-transaction.startOffset),walSalt1:parsed.header.salt1,walSalt2:parsed.header.salt2,nodeId:0n}
      await options.store.put(ltxKey(base,min,min),Ltx.encode(header,pages,0n))
      next.walOffset=transaction.endOffset; next.walSalt1=parsed.header.salt1; next.walSalt2=parsed.header.salt2; await save(next)
    }
  }

  const sync = async (): Promise<Position> => {
    if(active)return active
    active=(async()=>{ await load(); if(state.txId===0n)await snapshot(); ensureGuard();await syncWal(); return Object.freeze({txId:state.txId,checksum:state.checksum}) })()
    try{return await active}finally{active=undefined}
  }

  const restore = async (outputPath:string): Promise<Position> => {
    const prefix=`${join(base,"ltx")}/`
    const infos=(await options.store.list(prefix)).filter(info=>info.key.startsWith(prefix)&&info.key.endsWith(".ltx")).sort((a,b)=>a.key.localeCompare(b.key)); if(infos.length===0)throw new Error("no LTX files found")
    const pages=new Map<number,Uint8Array>(); let position:Position={txId:0n,checksum:0n}, pageSize=0, commit=0
    for(const info of infos) { const value=await options.store.get(info.key); if(!value)throw new Error(`missing LTX object: ${info.key}`); const file=Ltx.decode(value)
      if(file.header.minTxId!==position.txId+1n||(!(file.header.flags&Ltx.NoChecksum)&&file.header.preApplyChecksum!==position.checksum))throw new Error(`non-contiguous LTX file: ${info.key}`)
      for(const page of file.pages)pages.set(page.pageNumber,page.data); for(const page of [...pages.keys()])if(page>file.header.commit)pages.delete(page)
      const actual=Checksum.database([...pages].map(([number,data])=>[number,data] as const)); if(!(file.header.flags&Ltx.NoChecksum)&&actual!==file.postApplyChecksum)throw new Error(`post-apply checksum mismatch: ${info.key}`)
      position=Object.freeze({txId:file.header.maxTxId,checksum:actual}); pageSize=file.header.pageSize; commit=file.header.commit
    }
    const output=new Uint8Array(pageSize*commit); for(const [page,data] of pages)output.set(data,(page-1)*pageSize)
    // A standalone restored file must open without WAL/SHM sidecars, including
    // through a read-only SQLite connection.
    if(output.length>=100){output[18]=1;output[19]=1}
    const temporary=`${outputPath}.ltx-js-${crypto.randomUUID()}.tmp`
    try { await Bun.write(temporary,output); await rename(temporary,outputPath) }
    finally { await rm(temporary,{force:true}) }
    return position
  }

  const schedule = () => { if(stopped)return; timer=setTimeout(async()=>{ try{await sync()}catch(error){options.onError?.(error)}finally{schedule()} },options.interval??1000) }
  return Object.freeze({sync,restore,start:()=>{if(!stopped)return;stopped=false;schedule()},stop:async()=>{stopped=true;if(timer)clearTimeout(timer);try{if(active)await active}finally{closeGuard()}},position:()=>Object.freeze({txId:state.txId,checksum:state.checksum})})
}
