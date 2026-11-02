import { describe, expect, test } from "bun:test"
import * as Binary from "../src/Binary.ts"
import * as Wal from "../src/Wal.ts"

const makeWal = (frames: ReadonlyArray<readonly [number, number, number]>, trailing = 0): Uint8Array => {
  const pageSize=512, frameSize=Wal.FrameHeaderSize+pageSize
  const out=new Uint8Array(Wal.HeaderSize+frames.length*frameSize+trailing)
  Binary.setU32(out,0,Wal.MagicLittleEndianChecksums); Binary.setU32(out,4,3007000); Binary.setU32(out,8,pageSize); Binary.setU32(out,16,11); Binary.setU32(out,20,22)
  let sum=Wal.checksum(out.subarray(0,24),true);Binary.setU32(out,24,sum.first);Binary.setU32(out,28,sum.second)
  frames.forEach(([pageNumber,commit,byte],i)=>{ const offset=Wal.HeaderSize+i*frameSize; Binary.setU32(out,offset,pageNumber); Binary.setU32(out,offset+4,commit); Binary.setU32(out,offset+8,11); Binary.setU32(out,offset+12,22); out.fill(byte,offset+24,offset+frameSize) })
  frames.forEach((_,i)=>{const offset=Wal.HeaderSize+i*frameSize;sum=Wal.checksum(out.subarray(offset,offset+8),true,sum);sum=Wal.checksum(out.subarray(offset+24,offset+frameSize),true,sum);Binary.setU32(out,offset+16,sum.first);Binary.setU32(out,offset+20,sum.second)})
  return out
}

describe("SQLite WAL", () => {
  test("groups frames at commit markers",()=>{ const result=Wal.parse(makeWal([[1,0,1],[2,2,2],[2,0,3],[3,3,4]])); expect(result.transactions.map(t=>t.frames.length)).toEqual([2,2]); expect(result.transactions.map(t=>t.commit)).toEqual([2,3]) })
  test("does not expose an incomplete transaction",()=>{ const result=Wal.parse(makeWal([[1,1,1],[2,0,2]],17)); expect(result.transactions).toHaveLength(1); expect(result.trailingFrames).toHaveLength(1); expect(result.nextOffset).toBe(Wal.HeaderSize+Wal.FrameHeaderSize+512) })
  test("stops at a stale salt",()=>{ const value=makeWal([[1,1,1],[2,2,2]]); Binary.setU32(value,Wal.HeaderSize+Wal.FrameHeaderSize+512+8,99); expect(Wal.parse(value).transactions).toHaveLength(1) })
  test("collapses duplicate pages using last write",()=>{ const tx=Wal.parse(makeWal([[2,0,1],[1,0,2],[2,2,3]])).transactions[0]!; const pages=Wal.transactionPages(tx); expect(pages.map(([n])=>n)).toEqual([1,2]); expect(pages[1]![1][0]).toBe(3) })
  test("rejects invalid magic and page size",()=>{ const value=makeWal([]); Binary.setU32(value,0,0); expect(()=>Wal.parse(value)).toThrow("magic"); Binary.setU32(value,0,Wal.MagicBigEndianChecksums); Binary.setU32(value,8,1000); expect(()=>Wal.parse(value)).toThrow("page size") })
  test("rejects corrupted headers and frames",()=>{const header=makeWal([]);header[12]=header[12]!^1;expect(()=>Wal.parse(header)).toThrow("header checksum");const frame=makeWal([[1,1,1]]);frame[frame.length-1]=frame[frame.length-1]!^1;expect(()=>Wal.parse(frame)).toThrow("frame checksum")})
})
