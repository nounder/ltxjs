import * as Binary from "./Binary.ts"

export const HeaderSize = 32
export const FrameHeaderSize = 24
export const MagicLittleEndianChecksums = 0x377f0682
export const MagicBigEndianChecksums = 0x377f0683

export interface Header {
  readonly magic: number; readonly format: number; readonly pageSize: number
  readonly checkpointSequence: number; readonly salt1: number; readonly salt2: number
  readonly checksum1: number; readonly checksum2: number
}
export interface Frame {
  readonly pageNumber: number; readonly commit: number; readonly salt1: number; readonly salt2: number
  readonly checksum1: number; readonly checksum2: number; readonly data: Uint8Array; readonly offset: number
}
export interface Transaction { readonly frames: ReadonlyArray<Frame>; readonly commit: number; readonly startOffset: number; readonly endOffset: number }
export interface ParseResult { readonly header: Header; readonly transactions: ReadonlyArray<Transaction>; readonly trailingFrames: ReadonlyArray<Frame>; readonly nextOffset: number }

export interface Checksum { readonly first: number; readonly second: number }

/** SQLite WAL rolling checksum over a multiple of eight bytes. */
export const checksum = (input:Uint8Array, littleEndian:boolean, initial:Checksum={first:0,second:0}):Checksum => {
  if(input.length%8!==0)throw new Error("WAL checksum input must be a multiple of 8 bytes")
  const view=new DataView(input.buffer,input.byteOffset,input.byteLength);let first=initial.first>>>0,second=initial.second>>>0
  for(let offset=0;offset<input.length;offset+=8){first=(first+view.getUint32(offset,littleEndian)+second)>>>0;second=(second+view.getUint32(offset+4,littleEndian)+first)>>>0}
  return Object.freeze({first,second})
}

export const decodeHeader = (input: Uint8Array): Header => {
  if (input.length < HeaderSize) throw new Error("truncated WAL header")
  const magic = Binary.getU32(input, 0)
  if (magic !== MagicLittleEndianChecksums && magic !== MagicBigEndianChecksums) throw new Error("invalid WAL magic")
  const pageSizeField = Binary.getU32(input, 8)
  const pageSize = pageSizeField === 1 ? 65536 : pageSizeField
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw new Error("invalid WAL page size")
  return Object.freeze({ magic, format: Binary.getU32(input,4), pageSize, checkpointSequence: Binary.getU32(input,12), salt1: Binary.getU32(input,16), salt2: Binary.getU32(input,20), checksum1: Binary.getU32(input,24), checksum2: Binary.getU32(input,28) })
}

/** Parses complete committed transactions. An incomplete final transaction is retained separately. */
export const parse = (input: Uint8Array): ParseResult => {
  const header = decodeHeader(input)
  const littleEndian=header.magic===MagicLittleEndianChecksums, headerChecksum=checksum(input.subarray(0,24),littleEndian)
  if(headerChecksum.first!==header.checksum1||headerChecksum.second!==header.checksum2)throw new Error("WAL header checksum mismatch")
  const frameSize = FrameHeaderSize + header.pageSize
  const transactions: Transaction[] = []; let pending: Frame[] = []; let offset = HeaderSize; let startOffset = offset, rolling:Checksum=headerChecksum
  while (offset + frameSize <= input.length) {
    const salt1 = Binary.getU32(input, offset + 8); const salt2 = Binary.getU32(input, offset + 12)
    if (salt1 !== header.salt1 || salt2 !== header.salt2) break
    const frame: Frame = Object.freeze({ pageNumber: Binary.getU32(input,offset), commit: Binary.getU32(input,offset+4), salt1, salt2, checksum1: Binary.getU32(input,offset+16), checksum2: Binary.getU32(input,offset+20), data: input.slice(offset+FrameHeaderSize,offset+frameSize), offset })
    if (frame.pageNumber === 0) throw new Error("invalid WAL page number")
    rolling=checksum(input.subarray(offset,offset+8),littleEndian,rolling);rolling=checksum(frame.data,littleEndian,rolling)
    if(rolling.first!==frame.checksum1||rolling.second!==frame.checksum2)throw new Error(`WAL frame checksum mismatch at offset ${offset}`)
    pending.push(frame); offset += frameSize
    if (frame.commit !== 0) {
      transactions.push(Object.freeze({ frames: Object.freeze(pending), commit: frame.commit, startOffset, endOffset: offset }))
      pending = []; startOffset = offset
    }
  }
  return Object.freeze({ header, transactions: Object.freeze(transactions), trailingFrames: Object.freeze(pending), nextOffset: transactions.at(-1)?.endOffset ?? HeaderSize })
}

/** Last-write-wins page set for converting WAL frames into an LTX transaction. */
export const transactionPages = (transaction: Transaction): ReadonlyArray<readonly [number, Uint8Array]> => {
  const pages = new Map<number, Uint8Array>()
  for (const frame of transaction.frames) if (frame.pageNumber <= transaction.commit) pages.set(frame.pageNumber, frame.data)
  return Object.freeze([...pages].sort(([a], [b]) => a - b).map(([pageNumber, data]) => Object.freeze([pageNumber, data] as const)))
}
