import * as Binary from "./Binary.ts"
import * as Checksum from "./Checksum.ts"
import * as Lz4 from "./Lz4.ts"

export const Magic = "LTX1"
export const Version = 3
export const HeaderSize = 100
export const PageHeaderSize = 6
export const TrailerSize = 16
export const NoChecksum = 1 << 1
export const PageHeaderFlagSize = 1

export interface Header {
  readonly flags: number; readonly pageSize: number; readonly commit: number
  readonly minTxId: bigint; readonly maxTxId: bigint; readonly timestamp: bigint
  readonly preApplyChecksum: bigint; readonly walOffset: bigint; readonly walSize: bigint
  readonly walSalt1: number; readonly walSalt2: number; readonly nodeId: bigint
}
export interface Page { readonly pageNumber: number; readonly data: Uint8Array }
export interface File { readonly header: Header; readonly pages: ReadonlyArray<Page>; readonly postApplyChecksum: bigint; readonly fileChecksum: bigint }

const validPageSize = (size: number): boolean => size >= 512 && size <= 65536 && (size & (size - 1)) === 0
export const lockPageNumber = (pageSize: number): number => Math.floor(0x40000000 / pageSize) + 1
export const formatTxId = (value: bigint): string => value.toString(16).padStart(16, "0")
export const formatFilename = (min: bigint, max: bigint): string => `${formatTxId(min)}-${formatTxId(max)}.ltx`
export const parseFilename = (name: string): readonly [bigint, bigint] => {
  const match = /^([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/.exec(name)
  if (!match) throw new Error(`invalid LTX filename: ${name}`)
  return [BigInt(`0x${match[1]}`), BigInt(`0x${match[2]}`)]
}

export const validateHeader = (header: Header): void => {
  if (header.flags !== (header.flags & NoChecksum)) throw new Error("invalid header flags")
  if (!validPageSize(header.pageSize)) throw new Error("invalid page size")
  if (header.minTxId === 0n || header.maxTxId === 0n || header.minTxId > header.maxTxId) throw new Error("invalid transaction range")
  if (header.walOffset < 0n || header.walSize < 0n || (header.walOffset === 0n && header.walSize !== 0n)) throw new Error("invalid WAL range")
  if ((header.walSalt1 !== 0 || header.walSalt2 !== 0) && header.walOffset === 0n) throw new Error("WAL offset required with salts")
  if (header.minTxId === 1n && header.preApplyChecksum !== 0n) throw new Error("snapshot pre-apply checksum must be zero")
  if (header.minTxId !== 1n && !(header.flags & NoChecksum) && !(header.preApplyChecksum & Checksum.Flag)) throw new Error("pre-apply checksum required")
}

const encodeHeader = (header: Header): Uint8Array => {
  const out = new Uint8Array(HeaderSize); out.set(new TextEncoder().encode(Magic))
  Binary.setU32(out, 4, header.flags); Binary.setU32(out, 8, header.pageSize); Binary.setU32(out, 12, header.commit)
  Binary.setU64(out, 16, header.minTxId); Binary.setU64(out, 24, header.maxTxId); Binary.setU64(out, 32, header.timestamp)
  Binary.setU64(out, 40, header.preApplyChecksum); Binary.setU64(out, 48, header.walOffset); Binary.setU64(out, 56, header.walSize)
  Binary.setU32(out, 64, header.walSalt1); Binary.setU32(out, 68, header.walSalt2); Binary.setU64(out, 72, header.nodeId)
  return out
}

export const encode = (header: Header, pages: ReadonlyArray<Page>, postApplyChecksum: bigint): Uint8Array => {
  validateHeader(header)
  let previous = 0
  const lockPage=lockPageNumber(header.pageSize)
  const index: Uint8Array[] = [], blocks: Uint8Array[] = [], logical:Uint8Array[]=[]
  let offset = HeaderSize
  for (const item of pages) {
    if (item.pageNumber <= previous || item.pageNumber > header.commit || item.pageNumber === lockPage) throw new Error("invalid page order or number")
    if (item.data.length !== header.pageSize) throw new Error("invalid page size")
    if (header.minTxId === 1n && item.pageNumber !== previous + (previous===lockPage-1?2:1)) throw new Error("snapshot pages must be sequential")
    const pageHeader = new Uint8Array(PageHeaderSize); Binary.setU32(pageHeader, 0, item.pageNumber);Binary.setU16(pageHeader,4,PageHeaderFlagSize)
    const compressed=Lz4.encodeBlock(item.data),size=new Uint8Array(4);Binary.setU32(size,0,compressed.length)
    blocks.push(pageHeader,size,compressed);logical.push(pageHeader,size,item.data)
    const frameSize=PageHeaderSize+4+compressed.length;index.push(Binary.uvarint(BigInt(item.pageNumber)), Binary.uvarint(BigInt(offset)), Binary.uvarint(BigInt(frameSize)))
    offset += frameSize; previous = item.pageNumber
  }
  if (header.minTxId === 1n && pages.length !== header.commit-(lockPage<=header.commit?1:0)) throw new Error("snapshot must contain every page except the lock page")
  const terminator = new Uint8Array(PageHeaderSize)
  const indexData = Binary.concat(...index, Uint8Array.of(0)); const indexSize = new Uint8Array(8); Binary.setU64(indexSize, 0, BigInt(indexData.length))
  const headerData=encodeHeader(header),prefix = Binary.concat(headerData, ...blocks, terminator, indexData, indexSize)
  const post = new Uint8Array(8); Binary.setU64(post, 0, postApplyChecksum)
  const fileChecksum = Checksum.Flag | Checksum.crc64(Binary.concat(headerData,...logical,terminator,indexData,indexSize,post))
  const checksum = new Uint8Array(8); Binary.setU64(checksum, 0, fileChecksum)
  return Binary.concat(prefix, post, checksum)
}

export const decode = (input: Uint8Array): File => {
  if (input.length < HeaderSize + PageHeaderSize + 1 + 8 + TrailerSize || new TextDecoder().decode(input.subarray(0, 4)) !== Magic) throw new Error("invalid LTX file")
  const header: Header = Object.freeze({ flags: Binary.getU32(input,4), pageSize: Binary.getU32(input,8), commit: Binary.getU32(input,12), minTxId: Binary.getU64(input,16), maxTxId: Binary.getU64(input,24), timestamp: Binary.getU64(input,32), preApplyChecksum: Binary.getU64(input,40), walOffset: Binary.getU64(input,48), walSize: Binary.getU64(input,56), walSalt1: Binary.getU32(input,64), walSalt2: Binary.getU32(input,68), nodeId: Binary.getU64(input,72) })
  validateHeader(header)
  const pages: Page[] = []; let offset = HeaderSize; let previous = 0;const logical:Uint8Array[]=[input.subarray(0,HeaderSize)]
  while (true) {
    if (offset + PageHeaderSize > input.length) throw new Error("truncated page header")
    const pageHeader=input.subarray(offset,offset+PageHeaderSize),pageNumber = Binary.getU32(input, offset), flags = Binary.getU16(input, offset + 4); offset += PageHeaderSize;logical.push(pageHeader)
    if (pageNumber === 0) break
    if (flags !== PageHeaderFlagSize) throw new Error("unsupported legacy LTX page encoding")
    if (pageNumber <= previous || pageNumber > header.commit || offset+4>input.length) throw new Error("invalid page")
    const sizeData=input.subarray(offset,offset+4),compressedSize=Binary.getU32(input,offset);offset+=4;if(offset+compressedSize>input.length)throw new Error("truncated compressed page")
    const data=Lz4.decodeBlock(input.subarray(offset,offset+compressedSize),header.pageSize);logical.push(sizeData,data);pages.push(Object.freeze({ pageNumber, data })); offset += compressedSize; previous = pageNumber
  }
  const trailerOffset=input.length-TrailerSize,indexSizeOffset=trailerOffset-8;if(indexSizeOffset<offset)throw new Error("truncated LTX index")
  const indexSize=Number(Binary.getU64(input,indexSizeOffset)),indexOffset=indexSizeOffset-indexSize;if(indexOffset!==offset)throw new Error("invalid LTX page index size")
  const postApplyChecksum = Binary.getU64(input, trailerOffset); const fileChecksum = Binary.getU64(input, trailerOffset+8)
  const actual = Checksum.Flag | Checksum.crc64(Binary.concat(...logical,input.subarray(indexOffset,trailerOffset+8)))
  if (actual !== fileChecksum) throw new Error("LTX file checksum mismatch")
  if(header.minTxId===1n&&!(header.flags&NoChecksum)&&Checksum.database(pages.map(page=>[page.pageNumber,page.data] as const))!==postApplyChecksum)throw new Error("LTX snapshot checksum mismatch")
  return Object.freeze({ header, pages: Object.freeze(pages), postApplyChecksum, fileChecksum })
}
