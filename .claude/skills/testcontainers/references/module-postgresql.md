# PostgreSQL module (`@testcontainers/postgresql`)

Source:
- https://node.testcontainers.org/modules/postgresql/

Use this module for relational tests where production is PostgreSQL.

## Install

```bash
npm install --save-dev @testcontainers/postgresql
npm install pg
npm install --save-dev @types/pg
```

## Execute a query

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

const postgres = await new PostgreSqlContainer("postgres:16-alpine")
  .withDatabase("app_e2e")
  .withUsername("test")
  .withPassword("test")
  .start();

const client = new Client({
  host: postgres.getHost(),
  port: postgres.getPort(),
  database: postgres.getDatabase(),
  user: postgres.getUsername(),
  password: postgres.getPassword(),
});

await client.connect();
const result = await client.query("SELECT 1 AS ok");
expect(result.rows[0]).toEqual({ ok: 1 });
await client.end();

await postgres.stop();
```

## Use URI-based config

```ts
process.env.DATABASE_URL = postgres.getConnectionUri();
```

## Snapshot/restore guidance

The PostgreSQL module supports snapshots (`snapshot()` and `restoreSnapshot()`) for fast reset cycles in heavier suites. Use it only when table truncation or reseed logic becomes a bottleneck.

## Notes

- Do not use `postgres` as the test database name if you plan to use snapshots.
- Keep connection env assignment before app bootstrap.

## Jest suite example

```ts
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";

describe("postgresql integration", () => {
  let postgres: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("suite_db")
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

  it("runs SQL and validates row content", async () => {
    const result = await client.query("SELECT 1 AS ok");

    expect(result.rows).toEqual([{ ok: 1 }]);
  });
});
```
