# LocalStack module (`@testcontainers/localstack`)

Source:
- https://node.testcontainers.org/modules/localstack/

Use this module when your app interacts with AWS APIs (S3, SQS, SNS, etc.) and you want an isolated local emulator in tests.

## Install

```bash
npm install --save-dev @testcontainers/localstack
npm install @aws-sdk/client-s3
```

## Minimal start + S3 bucket example

```ts
import { LocalstackContainer } from "@testcontainers/localstack";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

const localstack = await new LocalstackContainer("localstack/localstack:3.5").start();

const s3 = new S3Client({
  endpoint: localstack.getConnectionUri(),
  forcePathStyle: true,
  region: "us-east-1",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

const bucketName = "e2e-bucket";
await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
await s3.send(new HeadBucketCommand({ Bucket: bucketName }));

await localstack.stop();
```

## NestJS env wiring pattern

```ts
process.env.AWS_ENDPOINT = localstack.getConnectionUri();
process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "test";
process.env.AWS_SECRET_ACCESS_KEY = "test";
```

## Notes

- Prefer pinned images (`localstack/localstack:3.5`) for stable CI.
- Keep `forcePathStyle: true` for S3-compatible local endpoints.
- Stop the container in `afterAll` even if tests fail.

## Jest suite example

```ts
import { LocalstackContainer, StartedLocalStackContainer } from "@testcontainers/localstack";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";

describe("localstack S3 integration", () => {
  let localstack: StartedLocalStackContainer;
  let s3: S3Client;

  beforeAll(async () => {
    localstack = await new LocalstackContainer("localstack/localstack:3.5").start();

    s3 = new S3Client({
      endpoint: localstack.getConnectionUri(),
      forcePathStyle: true,
      region: "us-east-1",
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });
  });

  afterAll(async () => {
    await localstack?.stop();
  });

  it("creates and reads bucket metadata", async () => {
    await s3.send(new CreateBucketCommand({ Bucket: "suite-bucket" }));
    const result = await s3.send(new HeadBucketCommand({ Bucket: "suite-bucket" }));

    expect(result.$metadata.httpStatusCode).toBe(200);
  });
});
```
