# Docker Compose fundamentals (`DockerComposeEnvironment`)

Source:
- https://node.testcontainers.org/features/compose/

Use Compose support when a suite depends on several tightly-coupled services and a compose file is already available.

## Start selected services

```ts
import { DockerComposeEnvironment } from "testcontainers";

const environment = await new DockerComposeEnvironment(
  "/absolute/path/to/test/fixtures",
  "docker-compose.yml"
).up(["postgres", "redis"]);

const postgres = environment.getContainer("postgres-1");
const redis = environment.getContainer("redis-1");

process.env.DB_HOST = postgres.getHost();
process.env.DB_PORT = String(postgres.getMappedPort(5432));
process.env.REDIS_HOST = redis.getHost();
process.env.REDIS_PORT = String(redis.getMappedPort(6379));

await environment.down();
```

## Add wait strategy

```ts
import { DockerComposeEnvironment, Wait } from "testcontainers";

const environment = await new DockerComposeEnvironment("/path", "docker-compose.yml")
  .withWaitStrategy("postgres-1", Wait.forHealthCheck())
  .withWaitStrategy("redis-1", Wait.forLogMessage("Ready to accept connections"))
  .up(["postgres", "redis"]);
```

## Guidance

- `withWaitStrategy` uses container names (for example `postgres-1`), not service names.
- Prefer module containers unless compose offers clear maintenance benefits.

## Jest suite example

```ts
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from "testcontainers";

describe("compose fundamentals", () => {
  let environment: StartedDockerComposeEnvironment;

  beforeAll(async () => {
    environment = await new DockerComposeEnvironment(
      "/absolute/path/to/fixtures/compose",
      "docker-compose.yml"
    )
      .withWaitStrategy("redis-1", Wait.forLogMessage("Ready to accept connections"))
      .up(["redis"]);
  });

  afterAll(async () => {
    await environment?.down();
  });

  it("starts selected service and allows command execution", async () => {
    const redis = environment.getContainer("redis-1");
    const result = await redis.exec(["redis-cli", "PING"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("PONG");
  });
});
```
