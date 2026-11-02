# ltx-js

Litestream implemented for Bun JavaScript runtime.

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

