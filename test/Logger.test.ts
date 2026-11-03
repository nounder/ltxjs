import { describe, expect, test } from "bun:test"
import * as Logger from "../src/Logger.ts"

const time = "2024-01-01T00:00:00.000Z"

describe("Litestream logging", () => {
  test("writes slog text with quoted, single-line messages and attributes", () => {
    const lines: string[] = []
    const log = Logger.make({
      now: () => new Date(time),
      write: (line) => {
        lines.push(line)
      },
    })
    log("info", "replicating to", {
      path: '/tmp/a "quoted" database\n.sqlite',
      size: 42,
      enabled: true,
      missing: undefined,
      error: new Error("connection failed"),
    })
    expect(lines).toEqual([
      `time=${time} level=INFO msg="replicating to" path="/tmp/a \\"quoted\\" database\\n.sqlite" size=42 enabled=true error="connection failed"\n`,
    ])
  })

  test("writes JSON records with typed attributes and an unambiguous envelope", () => {
    const lines: string[] = []
    const log = Logger.make({
      type: "json",
      now: () => new Date(time),
      write: (line) => {
        lines.push(line)
      },
    })
    log("error", "sync error", {
      db: "app.sqlite",
      error: new Error("failed\nretry"),
      size: 123,
      retry: true,
      txid: 12n,
      missing: undefined,
      level: 0,
      msg: "ignored",
      time: "ignored",
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.split("\n")).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({
      time,
      level: "ERROR",
      msg: "sync error",
      db: "app.sqlite",
      error: "failed\nretry",
      size: 123,
      retry: true,
      txid: "12",
    })
  })

  test("filters by severity before producing records", () => {
    const levels: Logger.Level[] = ["trace", "debug", "info", "warn", "error"]
    for (const [index, threshold] of levels.entries()) {
      const lines: string[] = []
      let clocks = 0
      const log = Logger.make({
        level: threshold,
        type: "json",
        now: () => {
          clocks++
          return new Date(time)
        },
        write: (line) => {
          lines.push(line)
        },
      })
      for (const level of levels) log(level, "event")
      expect(lines.map((line) => JSON.parse(line).level)).toEqual(
        levels.slice(index).map((level) => level.toUpperCase()),
      )
      expect(clocks).toBe(levels.length - index)
    }
    expect(Logger.parseLevel("DEBUG")).toBe("debug")
    expect(Logger.parseLevel("WARNING")).toBe("warn")
    expect(() => Logger.parseLevel("verbose")).toThrow("invalid log level")
    expect(() => Logger.parseFormat("xml")).toThrow("invalid log format")
  })
})
