# MySQL module (`@testcontainers/mysql`)

Source:
- https://node.testcontainers.org/modules/mysql/

Use this module for applications that use MySQL in production or need MySQL-specific SQL behavior.

## Install

```bash
npm install --save-dev @testcontainers/mysql
npm install mysql2
```

## Execute query from test

```ts
import { MySqlContainer } from "@testcontainers/mysql";
import { createConnection } from "mysql2/promise";

const mysql = await new MySqlContainer("mysql:8.4")
  .withDatabase("app_e2e")
  .withUsername("test")
  .withUserPassword("test")
  .start();

const connection = await createConnection({
  host: mysql.getHost(),
  port: mysql.getPort(),
  database: mysql.getDatabase(),
  user: mysql.getUsername(),
  password: mysql.getUserPassword(),
});

const [rows] = await connection.execute("SELECT 1 AS ok");
expect(rows).toEqual([{ ok: 1 }]);

await connection.end();
await mysql.stop();
```

## In-container query shortcut

```ts
const mysql = await new MySqlContainer("mysql:8.4").start();
const output = await mysql.executeQuery("SELECT 2 AS value");
expect(output).toContain("value");
expect(output).toContain("2");
await mysql.stop();
```

## Notes

- Prefer `mysql:8.x` tags that match your production major version.
- Inject `mysql.getConnectionUri()` directly when your app supports URI-based config.

## Jest suite example

```ts
import { MySqlContainer, StartedMySqlContainer } from "@testcontainers/mysql";
import { Connection, createConnection } from "mysql2/promise";

describe("mysql integration", () => {
  let mysql: StartedMySqlContainer;
  let connection: Connection;

  beforeAll(async () => {
    mysql = await new MySqlContainer("mysql:8.4")
      .withDatabase("suite_db")
      .withUsername("test")
      .withUserPassword("test")
      .start();

    connection = await createConnection({
      host: mysql.getHost(),
      port: mysql.getPort(),
      database: mysql.getDatabase(),
      user: mysql.getUsername(),
      password: mysql.getUserPassword(),
    });
  });

  afterAll(async () => {
    await connection?.end();
    await mysql?.stop();
  });

  it("executes SQL against the started container", async () => {
    const [rows] = await connection.execute("SELECT 1 AS ok");

    expect(rows).toEqual([{ ok: 1 }]);
  });
});
```
