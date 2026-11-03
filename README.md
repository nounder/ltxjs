# ltx-js

Litestream implemented for Bun JavaScript runtime.

## CLI

Requires Bun. Use `bun run cli`, or `bun link` to install `ltxjs`.

```sh
# Continuously replicate to a local directory; Ctrl+C flushes and stops.
bun run cli replicate app.sqlite file:///absolute/path/to/backup

# Replicate once, then exit. Relative directories also work.
bun run cli replicate -once app.sqlite ./backup

# Restore into a new database.
bun run cli restore -o restored.sqlite ./backup

# S3 uses credentials from the environment.
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
bun run cli replicate app.sqlite s3://backups/production/app
bun run cli restore -o restored.sqlite s3://backups/production/app

bun run cli --help
```

Destinations accept directory paths, `file://`, or `s3://` URLs. S3 requires `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; optionally set `AWS_REGION`, `AWS_SESSION_TOKEN`, and `AWS_ENDPOINT_URL_S3` for custom endpoints. AWS profiles and instance roles are unsupported.

Replication polls every second and flushes on SIGINT/SIGTERM. Restore refuses existing files or SQLite sidecars; `-if-db-not-exists` skips existing outputs and `-if-replica-exists` skips empty replicas.

Supports one database and destination, without YAML configuration, retention, or point-in-time restore. CLI replicas contain `0000/*.ltx` directly; the library adds an `ltx/` prefix. Restore selects the newest full snapshot and replays a contiguous chain across compaction levels, skipping files already covered by that chain. A replica URL may point at a parent directory containing one database; specify the database prefix when multiple replicas exist.

## Usage

```ts
import { Replica, S3 } from "ltx-js"

const store = S3.make({
  endpoint: "https://s3.example.com",
  bucket: "backups",
  prefix: "production/app",
  region: "us-east-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
})

const replica = Replica.make({ databasePath: "app.sqlite", store })
replica.start()

// During shutdown:
await replica.stop()

// Or restore into a new path:
await replica.restore("restored.sqlite")
```

`sync()` is also available for explicit, serialized replication. Snapshot creation uses SQLite serialization under a writer lock, with a read guard preserving subsequent WAL frames. Only committed, checksum-valid WAL transactions are uploaded.

## Logging

The CLI follows [Litestream's logging format](https://litestream.io/reference/config/#logging): `text` (slog-style key/value pairs) or newline-delimited `json`, with `time`, `level`, and `msg` fields. It defaults to `info` on stdout. Replication startup, restore completion, conditional restore skips, shutdown, and failures are logged; `debug` adds LTX uploads, transaction positions, and restore progress. Idle polls do not emit logs.

```sh
bun run cli replicate -log-level debug -log-format json -log-stderr app.sqlite ./backup
bun run cli restore -log-format json -o restored.sqlite ./backup
LOG_LEVEL=warn bun run cli replicate app.sqlite ./backup
```

Both commands accept `-log-level`, `-log-format`, and `-log-stderr` with one or two dashes. Levels are `trace`, `debug`, `info`, `warn`, and `error` (case-insensitive; `warning` is an alias). `-log-level` overrides `LOG_LEVEL`. Numeric LTX compaction levels use `ltx_level` so the severity field remains unambiguous.

The library stays silent unless given a logger. Use the included formatter or provide a `(level, message, fields) => void` callback; background failures still invoke `onError`.

```ts
import { Logger, Replica } from "nodelite"

const replica = Replica.make({
  databasePath: "app.sqlite",
  store,
  logger: Logger.make({ level: "debug", type: "json", stderr: true })
})
```

## Local S3 integration


```sh
docker compose up -d --wait
bun run test:integration
docker compose down
```

No npm runtime packages are used. VersityGW and Litestream are optional external executables used only by integration tests and comparative benchmarks.

## Benchmark

```sh
bun run bench
```

