import { describe,expect,test } from "bun:test"
import * as Lz4 from "../src/Lz4.ts"

describe("LZ4 block",()=>{
  test.each([0,1,14,15,255,512,65536])("round trips %i literal bytes",size=>{const input=Uint8Array.from({length:size},(_,index)=>index&255);expect(Lz4.decodeBlock(Lz4.encodeBlock(input),size)).toEqual(input)})
  test("decodes overlapping matches",()=>{const encoded=Uint8Array.of(0x44,97,98,99,100,4,0);expect(new TextDecoder().decode(Lz4.decodeBlock(encoded,12))).toBe("abcdabcdabcd")})
  test("rejects invalid blocks",()=>{expect(()=>Lz4.decodeBlock(Uint8Array.of(0,0,0),4)).toThrow("offset");expect(()=>Lz4.decodeBlock(Uint8Array.of(0x10,1),2)).toThrow("output size")})
})
