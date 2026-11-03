import * as ObjectStore from "./ObjectStore.ts"

export type Fetch = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

export interface Options {
  readonly endpoint: string
  readonly bucket: string
  readonly region?: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly prefix?: string
  readonly pathStyle?: boolean
  readonly fetch?: Fetch
  readonly now?: () => Date
  readonly maxAttempts?: number
  readonly retryDelay?: number
}

const encoder = new TextEncoder()
const hex = (value: ArrayBufferLike): string => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2,"0")).join("")
const sha256 = async (value: Uint8Array | string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : new Uint8Array(value)))
const hmac = async (key: Uint8Array, value: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new Uint8Array(key), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]), encoder.encode(value)))
const awsEncode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
const encodePath = (value: string): string => value.split("/").map(awsEncode).join("/")
const normalizePrefix = (value = ""): string => value.replace(/^\/+|\/+$/g, "")
const xmlDecode = (value: string): string => value.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&")

interface SignedRequest { readonly url: URL; readonly headers: Readonly<Record<string,string>> }
export const sign = async (options: Options, method: string, url: URL, payload: Uint8Array, now = new Date()): Promise<SignedRequest> => {
  const region=options.region ?? "us-east-1", service="s3"
  const amzDate=now.toISOString().replace(/[:-]|\.\d{3}/g, ""), date=amzDate.slice(0,8), payloadHash=await sha256(payload)
  const headers: Record<string,string> = { host:url.host, "x-amz-content-sha256":payloadHash, "x-amz-date":amzDate }
  if (options.sessionToken) headers["x-amz-security-token"]=options.sessionToken
  const signedHeaders=Object.keys(headers).sort().join(";")
  const canonicalHeaders=Object.keys(headers).sort().map(key=>`${key}:${headers[key]!.trim()}\n`).join("")
  const query=[...url.searchParams].map(([key,value])=>[awsEncode(key),awsEncode(value)] as const).sort(([ak,av],[bk,bv])=>ak<bk?-1:ak>bk?1:av<bv?-1:av>bv?1:0).map(([key,value])=>`${key}=${value}`).join("&")
  const canonicalRequest=`${method}\n${url.pathname}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const scope=`${date}/${region}/${service}/aws4_request`
  const stringToSign=`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonicalRequest)}`
  const kDate=await hmac(encoder.encode(`AWS4${options.secretAccessKey}`),date), kRegion=await hmac(kDate,region), kService=await hmac(kRegion,service), kSigning=await hmac(kService,"aws4_request")
  const signature=hex((await hmac(kSigning,stringToSign)).buffer)
  headers.authorization=`AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  delete headers.host // fetch supplies Host; it was included in the canonical request.
  return Object.freeze({ url, headers:Object.freeze(headers) })
}

const keyUrl = (options: Options, key?: string, includePrefix=true): URL => {
  const endpoint=new URL(options.endpoint), cleanKey=normalizePrefix([includePrefix ? normalizePrefix(options.prefix) : "", normalizePrefix(key)].filter(Boolean).join("/"))
  if (options.pathStyle !== false) endpoint.pathname=`${endpoint.pathname.replace(/\/$/,"")}/${awsEncode(options.bucket)}${cleanKey ? `/${encodePath(cleanKey)}` : ""}`
  else { endpoint.hostname=`${options.bucket}.${endpoint.hostname}`; endpoint.pathname=`/${encodePath(cleanKey)}` }
  return endpoint
}

export const make = (options: Options): ObjectStore.ObjectStore => {
  const request = async (method: string, url: URL, body=new Uint8Array()): Promise<Response> => {
    const attempts=options.maxAttempts??5
    for(let attempt=1;;attempt++){
      try { const signed=await sign(options,method,url,body,options.now?.() ?? new Date()),response=await (options.fetch ?? globalThis.fetch)(signed.url,{ method, headers:signed.headers, ...(method === "PUT" ? {body} : {}) })
        if(response.ok||(response.status===404&&(method==="DELETE"||(method==="GET"&&!url.searchParams.has("list-type")))))return response
        const detail=(await response.text()).slice(0,1024),retryable=response.status===408||response.status===429||response.status>=500
        if(!retryable||attempt>=attempts)throw new Error(`S3 ${method} ${url.pathname} failed (${response.status}): ${detail}`)
      } catch(error) { if(attempt>=attempts||error instanceof Error&&error.message.startsWith("S3 "))throw error }
      await new Promise(resolve=>setTimeout(resolve,(options.retryDelay??100)*2**(attempt-1)))
    }
  }
  return Object.freeze<ObjectStore.ObjectStore>({
    put: async (key,value) => { await request("PUT",keyUrl(options,key),new Uint8Array(value)) },
    get: async key => { const response=await request("GET",keyUrl(options,key)); return response.status===404 ? undefined : new Uint8Array(await response.arrayBuffer()) },
    remove: async key => { await request("DELETE",keyUrl(options,key)) },
    list: async prefix => {
      const output: ObjectStore.ObjectInfo[]=[]; let continuation: string | undefined
      do {
        const url=keyUrl(options,undefined,false); url.searchParams.set("list-type","2"); url.searchParams.set("prefix",[normalizePrefix(options.prefix),prefix.replace(/^\/+/,"")].filter((part,index)=>index===1||part.length>0).join("/"))
        if (continuation) url.searchParams.set("continuation-token",continuation)
        const xml=await (await request("GET",url)).text()
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const part=match[1]!, field=(name:string)=>new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(part)?.[1]
          const fullKey=xmlDecode(field("Key") ?? ""), base=normalizePrefix(options.prefix), key=base && fullKey.startsWith(`${base}/`) ? fullKey.slice(base.length+1) : fullKey
          const etagValue=field("ETag"), etag=etagValue ? xmlDecode(etagValue).replace(/^"|"$/g,"") : undefined; const modified=field("LastModified")
          output.push(Object.freeze({ key, size:Number(field("Size") ?? 0), ...(etag ? {etag} : {}), ...(modified ? {lastModified:new Date(modified)} : {}) }))
        }
        continuation=/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]; if (continuation) continuation=xmlDecode(continuation)
      } while (continuation)
      return Object.freeze(output.sort((a,b)=>a.key.localeCompare(b.key)))
    }
  })
}

/** Creates the configured bucket. Intended for local S3 test environments. */
export const createBucket = async (options: Options): Promise<void> => {
  const url=keyUrl(options,undefined,false), body=new Uint8Array(), signed=await sign(options,"PUT",url,body,options.now?.()??new Date())
  const response=await (options.fetch??globalThis.fetch)(signed.url,{method:"PUT",headers:signed.headers,body})
  if(!response.ok && response.status!==409)throw new Error(`S3 bucket creation failed (${response.status}): ${(await response.text()).slice(0,1024)}`)
}
