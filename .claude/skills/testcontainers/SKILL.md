---
name: testcontainers-e2e
description: Arranges JS/TS backend e2e tests with Testcontainers using repeatable service containers (PostgreSQL, MySQL, Redis, RabbitMQ, NATS, MinIO, and LocalStack).
---

# Testcontainers E2E (JS/TS)

Use this skill when a JS/TS backend test needs real infrastructure instead of mocks.

## 1) Purpose and when to use

- Add or update endpoint-level e2e suites (typically Jest + supertest + NestJS).
- Replace locally managed dev services with per-suite disposable containers.
- Troubleshoot flaky CI caused by shared infrastructure or fixed ports.
- Expand existing Postgres-only suites to multi-service integration coverage.

## 2) Scope and non-goals

Scope:

- Backend integration/e2e tests in JS/TS.
- Testcontainers module usage for databases, brokers, and AWS-compatible services.
- Deterministic setup/teardown patterns that are CI-friendly.

Non-goals:

- Unit-test mocking patterns.
- Production deployment/container orchestration guidance.
- Docker optimization outside test reliability needs.

## 3) Mandatory behavior/rules

- Every backend endpoint change should include e2e coverage.
- E2e tests that depend on infrastructure must use Testcontainers, never local manually managed services.
- Keep backend endpoint tests end-to-end through NestJS DI and HTTP assertions.
- Keep multi-write backend flows transactional and synchronous.

## 4) Step-by-step workflow

1. Identify the endpoint behavior and required infrastructure.
2. Pick module containers from references (PostgreSQL, MySQL, Redis, RabbitMQ, NATS, MinIO, LocalStack).
3. Add or reuse a shared e2e harness under `test/` (for this repo, keep examples in `test/*.e2e-spec.ts`).
4. Start containers in `beforeAll` and inject runtime values into app config/env.
5. Initialize the Nest app with `Test.createTestingModule(...)` and `app.init()`.
6. Apply migration/schema/bootstrap data needed for deterministic assertions.
7. Execute HTTP assertions with `supertest`.
8. Cleanup in reverse order (`app.close()` first, then containers and networks).

## 5) Implementation rules and defaults

Core defaults:

- Prefer typed modules (`@testcontainers/postgresql`, `@testcontainers/redis`, etc.) over `GenericContainer`.
- Use mapped ports from container getters; do not hardcode host ports.
- Prefer explicit image tags (`postgres:16-alpine`) over floating defaults.
- Build connection config from container getters before app bootstrap.
- Keep one container lifecycle per e2e file by default.
- Keep fixtures deterministic and small.

Advanced defaults:

- Use a dedicated `Network` for container-to-container communication.
- Use Docker Compose only when orchestration complexity is higher than two to three services.
- Enable Testcontainers logs (`DEBUG=testcontainers*`) when startup diagnostics are needed.
- Avoid host bind mounts in tests unless there is no viable copy-to-container option.

## Fundamentals (read first)

These references explain the base primitives used by all module examples:

- Containers API: `references/feature-containers.md`
- Building and substituting images: `references/feature-images.md`
- Networks, aliases, and host-port exposure: `references/feature-networking.md`
- Docker Compose environments: `references/feature-compose.md`
- Debug logging for startup/troubleshooting: `references/quickstart-logging.md`

## Service modules and examples

Use these references based on the dependency under test:

- LocalStack (AWS emulation): `references/module-localstack.md`
- MinIO (S3-compatible object storage): `references/module-minio.md`
- MySQL: `references/module-mysql.md`
- NATS: `references/module-nats.md`
- PostgreSQL: `references/module-postgresql.md`
- RabbitMQ: `references/module-rabbitmq.md`
- Redis: `references/module-redis.md`

NestJS + Jest + supertest baseline:

- Canonical endpoint pattern: `references/postgres-nestjs-jest.md`

## 6) Troubleshooting checklist

- Docker daemon unavailable: fail early with a clear error in `beforeAll`.
- Tests hang: verify `await app.close()` and `await container.stop()` run in `afterAll`.
- Connection refused: ensure env/config values are assigned from getters before `app.init()`.
- Flaky startup: prefer module wait behavior or explicit wait strategies, never fixed sleeps.
- Port collisions: remove fixed host-port bindings.
- CI-only failures: pin image tags and inspect startup logs with `DEBUG=testcontainers*`.

## 7) References

Fundamentals:

- `references/feature-containers.md`
- `references/feature-images.md`
- `references/feature-networking.md`
- `references/feature-compose.md`
- `references/quickstart-logging.md`

Service modules:

- `references/module-localstack.md`
- `references/module-minio.md`
- `references/module-mysql.md`
- `references/module-nats.md`
- `references/module-postgresql.md`
- `references/module-rabbitmq.md`
- `references/module-redis.md`

Application-level pattern:

- `references/postgres-nestjs-jest.md`
- `references/node-testcontainers-quickstart.md`
