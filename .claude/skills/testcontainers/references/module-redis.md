# Redis module (`@testcontainers/redis`)

Source:
- https://node.testcontainers.org/modules/redis/

Use this module for cache, lock, and key-value integration tests.

## Install

```bash
npm install --save-dev @testcontainers/redis
npm install redis
```

## Set/get value

```ts
import { RedisContainer } from "@testcontainers/redis";
import { createClient } from "redis";

const redisContainer = await new RedisContainer("redis:7.4-alpine").start();
const client = createClient({ url: redisContainer.getConnectionUrl() });

await client.connect();
await client.set("health", "ok");
expect(await client.get("health")).toBe("ok");

await client.quit();
await redisContainer.stop();
```

## Password-protected Redis

```ts
const redisContainer = await new RedisContainer("redis:7.4-alpine")
  .withPassword("test-password")
  .start();

process.env.REDIS_URL = redisContainer.getConnectionUrl();
```

## Run Redis CLI command

```ts
const info = await redisContainer.executeCliCmd("INFO", ["clients"]);
expect(info).toContain("connected_clients");
```

## Notes

- Prefer `await client.quit()` over hard shutdown for cleaner teardown.
- Use isolated key prefixes or `FLUSHDB` between tests when state leakage matters.

## Jest suite example

```ts
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import { RedisClientType, createClient } from "redis";

describe("redis integration", () => {
  let redisContainer: StartedRedisContainer;
  let client: RedisClientType;

  beforeAll(async () => {
    redisContainer = await new RedisContainer("redis:7.4-alpine").start();
    client = createClient({ url: redisContainer.getConnectionUrl() });
    await client.connect();
  });

  afterAll(async () => {
    await client?.quit();
    await redisContainer?.stop();
  });

  it("writes and reads keys from redis", async () => {
    await client.set("suite:key", "value");

    const value = await client.get("suite:key");
    expect(value).toBe("value");
  });
});
```
