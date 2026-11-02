export const getU16 = (value: Uint8Array, offset: number): number =>
  new DataView(value.buffer, value.byteOffset, value.byteLength).getUint16(offset, false)

export const getU32 = (value: Uint8Array, offset: number): number =>
  new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(offset, false)

export const getU64 = (value: Uint8Array, offset: number): bigint =>
  new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(offset, false)

export const setU16 = (value: Uint8Array, offset: number, n: number): void =>
  new DataView(value.buffer, value.byteOffset, value.byteLength).setUint16(offset, n, false)

export const setU32 = (value: Uint8Array, offset: number, n: number): void =>
  new DataView(value.buffer, value.byteOffset, value.byteLength).setUint32(offset, n, false)

export const setU64 = (value: Uint8Array, offset: number, n: bigint): void =>
  new DataView(value.buffer, value.byteOffset, value.byteLength).setBigUint64(offset, n, false)

export const uvarint = (input: bigint): Uint8Array => {
  const bytes: number[] = []
  let value = input
  while (value >= 0x80n) { bytes.push(Number(value & 0x7fn) | 0x80); value >>= 7n }
  bytes.push(Number(value))
  return Uint8Array.from(bytes)
}

export const concat = (...values: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(values.reduce((n, value) => n + value.length, 0))
  let offset = 0
  for (const value of values) { output.set(value, offset); offset += value.length }
  return output
}
