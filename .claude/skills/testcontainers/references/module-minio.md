# MinIO module (`@testcontainers/minio`)

Source:
- https://node.testcontainers.org/modules/minio/

Use this module for S3-compatible object storage tests when you do not need broader AWS emulation.

## Install

```bash
npm install --save-dev @testcontainers/minio
npm install minio
```

## Upload and verify object

```ts
import { MinioContainer } from "@testcontainers/minio";
import { Client } from "minio";

const minio = await new MinioContainer("minio/minio:RELEASE.2024-08-03T04-33-23Z").start();

const client = new Client({
  endPoint: minio.getHost(),
  port: minio.getPort(),
  useSSL: false,
  accessKey: "minioadmin",
  secretKey: "minioadmin",
});

await client.makeBucket("test-bucket");
await client.putObject("test-bucket", "hello.txt", "hello from e2e");
const stat = await client.statObject("test-bucket", "hello.txt");

expect(stat.size).toBeGreaterThan(0);

await minio.stop();
```

## Custom credentials

```ts
const minio = await new MinioContainer("minio/minio:RELEASE.2024-08-03T04-33-23Z")
  .withUsername("test-user")
  .withPassword("test-pass-123")
  .start();
```

## Notes

- MinIO is ideal for object-storage integration tests without AWS-specific APIs.
- Use deterministic bucket/object names per suite to simplify cleanup and assertions.

## Jest suite example

```ts
import { MinioContainer, StartedMinioContainer } from "@testcontainers/minio";
import { Client } from "minio";

describe("minio object storage", () => {
  let minio: StartedMinioContainer;
  let client: Client;

  beforeAll(async () => {
    minio = await new MinioContainer("minio/minio:RELEASE.2024-08-03T04-33-23Z").start();

    client = new Client({
      endPoint: minio.getHost(),
      port: minio.getPort(),
      useSSL: false,
      accessKey: "minioadmin",
      secretKey: "minioadmin",
    });
  });

  afterAll(async () => {
    await minio?.stop();
  });

  it("uploads and reads object metadata", async () => {
    await client.makeBucket("suite-bucket");
    await client.putObject("suite-bucket", "suite.txt", "suite-body");

    const stat = await client.statObject("suite-bucket", "suite.txt");
    expect(stat.size).toBeGreaterThan(0);
  });
});
```
