export type Level = "trace" | "debug" | "info" | "warn" | "error"
export type Format = "text" | "json"
export type Fields = Readonly<
  Record<string, string | number | boolean | bigint | Error | null | undefined>
>
export type Logger = (level: Level, message: string, fields?: Fields) => void

export interface Options {
  readonly level?: Level
  readonly type?: Format
  readonly stderr?: boolean
  readonly now?: () => Date
  /** Receives one complete log line, including its trailing newline. */
  readonly write?: (line: string) => void
}

const levels: Readonly<Record<Level, number>> = { trace: -8, debug: -4, info: 0, warn: 4, error: 8 }

export const parseLevel = (value: string): Level => {
  const level = value.toLowerCase() === "warning" ? "warn" : value.toLowerCase()
  if (!Object.hasOwn(levels, level))
    throw new Error(`invalid log level: ${value} (use trace, debug, info, warn, or error)`)
  return level as Level
}

export const parseFormat = (value: string): Format => {
  if (value !== "text" && value !== "json")
    throw new Error(`invalid log format: ${value} (use text or json)`)
  return value
}

// slog's text handler quotes empty strings, whitespace, '=', quotes, and controls.
const quote = (value: string): string =>
  !value || /[\s\u0085\p{Cc}\p{Cf}="]/u.test(value) ? JSON.stringify(value) : value

/** Litestream-compatible slog text or newline-delimited JSON, info to stdout by default. */
export const make = (options: Options = {}): Logger => {
  const threshold = levels[parseLevel(options.level ?? "info")]
  const format = parseFormat(options.type ?? "text"),
    now = options.now ?? (() => new Date())
  const write =
    options.write ??
    ((line) => {
      ;(options.stderr ? process.stderr : process.stdout).write(line)
    })
  return (level, message, fields = {}) => {
    if (levels[level] < threshold) return
    const record: Record<string, string | number | boolean | null> = {
      time: now().toISOString(),
      level: level.toUpperCase(),
      msg: message,
    }
    for (const [key, value] of Object.entries(fields)) {
      // Keep the envelope unambiguous for collectors, even for an LTX's numeric level.
      if (value === undefined || key === "time" || key === "level" || key === "msg") continue
      Object.defineProperty(record, key, {
        enumerable: true,
        value:
          value instanceof Error
            ? value.message
            : typeof value === "bigint"
              ? String(value)
              : value,
      })
    }
    const line =
      format === "json"
        ? JSON.stringify(record)
        : Object.entries(record)
            .map(
              ([key, value]) =>
                `${quote(key)}=${typeof value === "string" ? quote(value) : String(value)}`,
            )
            .join(" ")
    write(`${line}\n`)
  }
}
