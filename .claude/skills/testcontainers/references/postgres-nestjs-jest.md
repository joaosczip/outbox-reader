# PostgreSQL Testcontainers Pattern for NestJS E2E

Use this pattern to arrange endpoint-level e2e suites with Jest + supertest and a dedicated PostgreSQL container.

## 1) Install dependencies

From repo root:

```bash
npm install --save-dev testcontainers @testcontainers/postgresql
```

## 2) Suite template

```ts
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { StartedPostgreSqlContainer, PostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';

import { AppModule } from '../src/app.module';

describe('Transactions API (e2e)', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('smart_budget_e2e')
      .withUsername('test')
      .withPassword('test')
      .start();

    process.env.DB_HOST = postgres.getHost();
    process.env.DB_PORT = String(postgres.getPort());
    process.env.DB_NAME = postgres.getDatabase();
    process.env.DB_USER = postgres.getUsername();
    process.env.DB_PASSWORD = postgres.getPassword();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Apply migrations or schema setup here if your app does not auto-sync in test mode.
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  it('creates a transaction', async () => {
    const response = await request(app.getHttpServer())
      .post('/transactions')
      .send({
        description: 'Coffee',
        amount: 12.5,
        type: 'expense',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      description: 'Coffee',
      amount: 12.5,
      type: 'expense',
    });
  });
});
```

## 3) Data isolation options

Choose one per suite:

- Transaction rollback per test (fast, good for service-level integration).
- Truncate/reseed affected tables in `beforeEach` (clear and explicit).
- Fresh container per test file (strong isolation, slower).

Default recommendation for endpoint e2e: fresh container per file + deterministic seed/reset per test when needed.

## 4) Multi-container extension

If endpoint behavior depends on Redis/NATS/etc.:

- Start additional containers in the same `beforeAll`.
- Inject each service connection value before `app.init()`.
- Stop all started containers in `afterAll`.

## 5) Common pitfalls

- Using localhost default DB values instead of container values.
- Bootstrapping Nest app before env vars are set.
- Forgetting `await app.close()` leading to hanging Jest processes.
- Running tests against developer databases.
