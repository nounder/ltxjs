import { describe, expect, test } from "bun:test"
import * as S3 from "../src/S3.ts"

const mock = () => {
  const objects=new Map<string,Uint8Array>()
  const fetcher: S3.Fetch = async (input, init) => {
    const url=new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url), method=init?.method ?? "GET", headers=new Headers(init?.headers)
    expect(headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 Credential=test/")
    const key=decodeURIComponent(url.pathname.replace(/^\/bucket\/?/,""))
    if (method==="PUT") { objects.set(key,new Uint8Array(await new Response(init?.body).arrayBuffer())); return new Response(null,{status:200}) }
    if (method==="DELETE") { objects.delete(key); return new Response(null,{status:204}) }
    if (url.searchParams.get("list-type")==="2") { const prefix=url.searchParams.get("prefix")??""; const contents=[...objects].filter(([name])=>name.startsWith(prefix)).map(([name,value])=>`<Contents><Key>${name}</Key><Size>${value.length}</Size><ETag>&quot;x&quot;</ETag></Contents>`).join(""); return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`) }
    const value=objects.get(key); return value ? new Response(new Uint8Array(value)) : new Response("missing",{status:404})
  }
  return { objects, fetcher, store:S3.make({endpoint:"http://s3.test",bucket:"bucket",accessKeyId:"test",secretAccessKey:"secret",pathStyle:true,fetch:fetcher,now:()=>new Date("2024-01-02T03:04:05Z")}) }
}

describe("S3 object store",()=>{
  test("puts, gets, lists, and removes objects",async()=>{ const {store}=mock(); await store.put("db/a.ltx",Uint8Array.of(1,2,3)); await store.put("other",Uint8Array.of(9)); expect(await store.get("db/a.ltx")).toEqual(Uint8Array.of(1,2,3)); expect((await store.list("db/")).map(x=>[x.key,x.size,x.etag])).toEqual([["db/a.ltx",3,"x"]]); await store.remove("db/a.ltx"); expect(await store.get("db/a.ltx")).toBeUndefined() })
  test("supports an immutable key prefix",async()=>{ const base=mock(); const scoped=S3.make({endpoint:"http://s3.test",bucket:"bucket",prefix:"root/db",accessKeyId:"test",secretAccessKey:"secret",fetch:base.fetcher,now:()=>new Date("2024-01-02T03:04:05Z")}); await scoped.put("x",Uint8Array.of(1)); expect(base.objects.has("root/db/x")).toBe(true); expect((await scoped.list("")).map(x=>x.key)).toEqual(["x"]) })
  test("retries transient transport and service failures",async()=>{let attempts=0;const base=mock(),store=S3.make({endpoint:"http://s3.test",bucket:"bucket",accessKeyId:"test",secretAccessKey:"secret",retryDelay:0,fetch:async(input,init)=>{attempts++;if(attempts===1)throw new TypeError("network reset");if(attempts===2)return new Response("busy",{status:503});return base.fetcher(input,init)}});await store.put("retried",Uint8Array.of(1));expect(attempts).toBe(3);expect(base.objects.has("retried")).toBe(true)})
  test("does not treat missing buckets as successful writes or listings",async()=>{
    const store=S3.make({endpoint:"http://s3.test",bucket:"missing",accessKeyId:"test",secretAccessKey:"secret",fetch:async()=>new Response("NoSuchBucket",{status:404})})
    await expect(store.put("x",Uint8Array.of(1))).rejects.toThrow("404")
    await expect(store.list("")).rejects.toThrow("404")
    expect(await store.get("x")).toBeUndefined()
    await store.remove("x")
  })
  test("preserves directory boundaries when listing prefixed objects",async()=>{
    const base=mock()
    await base.store.put("db/a.ltx",Uint8Array.of(1))
    await base.store.put("db-other/b.ltx",Uint8Array.of(2))
    await base.store.put("db/nested/x",Uint8Array.of(3))
    await base.store.put("db/nested-other/y",Uint8Array.of(4))
    expect((await base.store.list("db/")).map(info=>info.key)).toEqual(["db/a.ltx","db/nested-other/y","db/nested/x"])
    const scoped=S3.make({endpoint:"http://s3.test",bucket:"bucket",prefix:"db",accessKeyId:"test",secretAccessKey:"secret",fetch:base.fetcher})
    expect((await scoped.list("")).map(info=>info.key)).toEqual(["a.ltx","nested-other/y","nested/x"])
    expect((await scoped.list("nested/")).map(info=>info.key)).toEqual(["nested/x"])
  })

})
