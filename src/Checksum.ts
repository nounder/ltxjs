import * as Binary from "./Binary.ts"

export const Flag = 1n << 63n
const Mask = (1n << 64n) - 1n
const Polynomial = 0xd800000000000000n

const Table: ReadonlyArray<bigint> = Object.freeze(Array.from({ length: 256 }, (_, i) => {
  let crc = BigInt(i)
  for (let bit = 0; bit < 8; bit++) crc = crc & 1n ? (crc >> 1n) ^ Polynomial : crc >> 1n
  return crc & Mask
}))

/** Go hash/crc64 ISO-compatible checksum. */
export const crc64 = (value: Uint8Array, initial = 0n): bigint => {
  let crc = initial ^ Mask
  for (const byte of value) crc = Table[Number((crc ^ BigInt(byte)) & 0xffn)]! ^ (crc >> 8n)
  return (crc ^ Mask) & Mask
}

export const page = (pageNumber: number, data: Uint8Array): bigint => {
  const value = new Uint8Array(data.length + 4)
  Binary.setU32(value, 0, pageNumber)
  value.set(data, 4)
  return Flag | crc64(value)
}

export const database = (pages: ReadonlyArray<readonly [number, Uint8Array]>): bigint =>
  Flag | pages.reduce((sum, [pageNumber, data]) => sum ^ page(pageNumber, data), 0n)

export const format = (value: bigint): string => value.toString(16).padStart(16, "0")
