import { describe, expect, test } from "bun:test"
import * as Checksum from "../src/Checksum.ts"
import * as Ltx from "../src/Ltx.ts"

const header = (overrides: Partial<Ltx.Header> = {}): Ltx.Header => ({ flags: 0, pageSize: 512, commit: 2, minTxId: 1n, maxTxId: 1n, timestamp: 123n, preApplyChecksum: 0n, walOffset: 0n, walSize: 0n, walSalt1: 0, walSalt2: 0, nodeId: 0n, ...overrides })
const data = (byte: number) => new Uint8Array(512).fill(byte)

describe("LTX v3", () => {
  test("round trips an immutable snapshot", () => {
    const encoded = Ltx.encode(header(), [{ pageNumber: 1, data: data(1) }, { pageNumber: 2, data: data(2) }], Checksum.database([[1,data(1)],[2,data(2)]]))
    const decoded = Ltx.decode(encoded)
    expect(decoded.header).toEqual(header()); expect(decoded.pages.map(p => p.pageNumber)).toEqual([1,2]); expect(decoded.pages[1]!.data[0]).toBe(2)
    expect(Object.isFrozen(decoded)).toBe(true); expect(Object.isFrozen(decoded.pages)).toBe(true)
  })
  test.each([511, 513, 131072])("rejects invalid page size %i", pageSize => expect(() => Ltx.encode(header({ pageSize }), [], 0n)).toThrow("page size"))
  test("rejects unknown flags", () => expect(() => Ltx.encode(header({ flags: 1 }), [], 0n)).toThrow("flags"))
  test("rejects incomplete snapshots", () => expect(() => Ltx.encode(header(), [{pageNumber:1,data:data(1)}], Checksum.Flag)).toThrow("every page"))
  test("rejects corrupt files", () => { const value=Ltx.encode(header({commit:1}),[{pageNumber:1,data:data(1)}],Checksum.page(1,data(1))); value[120]=value[120]!^1; expect(()=>Ltx.decode(value)).toThrow("checksum") })
  test("formats and parses canonical filenames", () => { const name=Ltx.formatFilename(1n,255n); expect(name).toBe("0000000000000001-00000000000000ff.ltx"); expect(Ltx.parseFilename(name)).toEqual([1n,255n]); expect(()=>Ltx.parseFilename("1-2.ltx")).toThrow() })
})

describe("checksums", () => {
  test("CRC-64/ISO check vector", () => expect(Checksum.format(Checksum.crc64(new TextEncoder().encode("123456789")))).toBe("b90956c775a41001"))
  test("page number affects checksum", () => expect(Checksum.page(1,data(0))).not.toBe(Checksum.page(2,data(0))))
  test("database checksum is order independent", () => expect(Checksum.database([[1,data(1)],[2,data(2)]])).toBe(Checksum.database([[2,data(2)],[1,data(1)]])))
})
