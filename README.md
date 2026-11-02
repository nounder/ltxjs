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

Supports one database and destination, without YAML configuration, retention, or point-in-time restore. CLI replicas contain `0000/*.ltx` directly; the library adds an `ltx/` prefix. Restore requires contiguous LTX history without overlapping compaction levels.

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

