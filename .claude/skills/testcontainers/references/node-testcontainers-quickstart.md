# Node Testcontainers Quickstart Notes

Source reference:
- https://node.testcontainers.org/quickstart/usage/

## Key points to apply in this repository

- Install `testcontainers` and typed modules for concrete services (for example `@testcontainers/postgresql`).
- Prefer module containers (e.g. PostgreSqlContainer) over GenericContainer when possible.
- Use async lifecycle with `start()` and `stop()` in Jest hooks.
- Read runtime values from container getters (`getHost()`, `getMappedPort()` or module equivalents) and inject into app config.
- Never rely on fixed host ports.

## Minimal usage pattern

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const container = await new PostgreSqlContainer('postgres:16-alpine')
  .withDatabase('e2e_db')
  .withUsername('test')
  .withPassword('test')
  .start();

const host = container.getHost();
const port = container.getPort();
const database = container.getDatabase();
const username = container.getUsername();
const password = container.getPassword();

await container.stop();
```

## Best-practice mapping for agent behavior

- Start infra once per suite unless test isolation demands per-test lifecycle.
- Keep startup explicit in `beforeAll` and cleanup explicit in `afterAll`.
- Avoid hidden global state; pass connection values through env/config visible in the test setup.
- Keep data setup deterministic and reset state between tests when assertions depend on clean state.

## Jest suite example

```ts
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";

describe("quickstart lifecycle", () => {
  let postgres: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("quickstart_db")
      .withUsername("test")
      .withPassword("test")
      .start();

    client = new Client({ connectionString: postgres.getConnectionUri() });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await postgres?.stop();
  });

  it("queries the started database", async () => {
    const result = await client.query("SELECT 1 AS ok");

    expect(result.rows).toEqual([{ ok: 1 }]);
  });
});
```
