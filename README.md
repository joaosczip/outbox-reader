# Outbox Reader

A service that implements the [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html) to reliably publish database changes to NATS JetStream.

## Monorepo Structure

| Package | Name | Description |
|---------|------|-------------|
| `packages/core` | `@outbox-reader/core` | Runtime service — WAL replication, event processing, NATS publishing, DB repository, cronjobs |
| `packages/client` | `@outbox-reader/client` | ORM-agnostic client for creating transactional outbox events via adapters |
| `packages/cli` | `@joaosczip/outy-cli` | Developer tooling — Prisma schema generator and CLI for setting up the outbox table |

The client and CLI have no dependency on core and can be used standalone.

## Quick Start

Requirements: Bun v1.2.0+, PostgreSQL with logical replication enabled, NATS with JetStream enabled.

```bash
# Start dependencies (PostgreSQL + NATS)
docker compose up -d

# Copy and fill in environment variables
cp .env.example .env

# Start the service
bun run start
```

## CLI

The `outy` CLI sets up the replication infrastructure and the outbox table.

```
outy create schema     — add outbox model to schema.prisma (no migration)
outy create migration  — add model + run prisma migrate dev
outy setup replication — create a PostgreSQL logical replication slot
```

### `outy setup replication`

#### Prerequisites

Before running this command, PostgreSQL must be configured for logical replication. Without this, the command will fail with `logical decoding requires wal_level >= logical`.

**1. Configure `postgresql.conf`**

Add or update these settings:

```
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

These settings require a **server restart** to take effect.

- **Managed/bare-metal Postgres:** edit `postgresql.conf`, then restart the server:
  ```sh
  pg_ctl restart
  # or
  systemctl restart postgresql
  ```
- **Docker CLI:** pass the settings as `-c` flags when starting the container:
  ```sh
  docker run -d \
    -e POSTGRES_PASSWORD=secret \
    -p 5432:5432 \
    postgres:16 \
    -c wal_level=logical \
    -c max_wal_senders=10 \
    -c max_replication_slots=10
  ```
  Then either create a user with the replication role:
  ```sh
  docker exec -it <container> psql -U postgres -c "CREATE USER outbox_user WITH LOGIN REPLICATION PASSWORD 'secret';"
  ```
  Or grant it to an existing user:
  ```sh
  docker exec -it <container> psql -U postgres -c "ALTER USER existing_user REPLICATION;"
  ```
- **docker-compose:** add a `command` entry to your `db` service:
  ```yaml
  services:
    db:
      image: postgres:16
      environment:
        POSTGRES_PASSWORD: secret
      command:
        - "postgres"
        - "-c"
        - "wal_level=logical"
        - "-c"
        - "max_wal_senders=10"
        - "-c"
        - "max_replication_slots=10"
  ```
  No restart is needed when using `-c` flags — the settings are active from container start.

  To set up the replication user, either create a dedicated one or grant the role to an existing user. You can use an init SQL script by mounting it into `/docker-entrypoint-initdb.d/`:
  ```yaml
  services:
    db:
      image: postgres:16
      volumes:
        - ./init.sql:/docker-entrypoint-initdb.d/init.sql
  ```
  **Option 1** — create a new user (`init.sql`):
  ```sql
  CREATE USER outbox_user WITH LOGIN REPLICATION PASSWORD 'secret';
  ```
  **Option 2** — grant replication to an existing user (`init.sql`):
  ```sql
  ALTER USER existing_user REPLICATION;
  ```
  Or apply it manually against a running container:
  ```sh
  docker compose exec db psql -U postgres -c "ALTER USER existing_user REPLICATION;"
  ```

Verify the settings took effect:

```sql
SHOW wal_level;
```

**2. User role requirements**

The connecting user must have `LOGIN` and `REPLICATION` roles:

```sql
CREATE USER outbox_user WITH LOGIN REPLICATION PASSWORD 'secret';
```

To grant the `REPLICATION` role to an existing user:

```sql
ALTER USER existing_user REPLICATION;
```

**3. Install wal2json**

`wal2json` is a PostgreSQL logical decoding plugin required for WAL replication. If it is missing, `outy setup replication` will fail with `could not access file "wal2json": No such file or directory`.

**Managed / bare-metal (Debian/Ubuntu):**

```sh
sudo apt-get install postgresql-17-wal2json
# Adjust version number to match your PostgreSQL installation
```

**Docker CLI / docker-compose:**

The official `postgres` image does not include `wal2json`. Build a custom image:

**`Dockerfile.pg`:**
```dockerfile
FROM postgres:17-bullseye

RUN apt-get update \
    && apt-get install -y postgresql-17-wal2json \
    && rm -rf /var/lib/apt/lists/*
```

**Docker CLI:**
```sh
docker build -f Dockerfile.pg -t postgres-wal2json .
docker run -d \
  -e POSTGRES_PASSWORD=secret \
  -p 5432:5432 \
  postgres-wal2json \
  -c wal_level=logical \
  -c max_wal_senders=10 \
  -c max_replication_slots=10
```

**docker-compose:**
```yaml
services:
  db:
    build:
      context: .
      dockerfile: Dockerfile.pg
    ...
```

**Verify the plugin is available:**

```sql
SELECT * FROM pg_available_extensions WHERE name = 'wal2json';
```

#### Options

```
-h, --host       PostgreSQL host               [default: localhost]
-p, --port       PostgreSQL port               [default: 5432]
-u, --user       PostgreSQL user               [required]
-P, --password   PostgreSQL password           [or set PGPASSWORD env var]
-d, --database   PostgreSQL database           [required]
-s, --slot-name  Replication slot name         [required]
```

#### Example

```sh
$ outy setup replication -h 127.0.0.1 -p 5434 -u postgres -P postgres -d my-db -s my-db-slot
```

You should receive the following output:

```sh
Replication slot "my-db-slot" created successfully.
```

### `outy create schema`

```
-s, --schema-path   Path to schema.prisma      [default: ./prisma/schema.prisma]
-m, --model-name    Outbox model name           [default: OutboxRecord]
-t, --table-name    Database table name         [default: outbox]
-c, --config        Path to configuration file
```

### `outy create migration`

```
-s, --schema-path   Path to schema.prisma      [default: ./prisma/schema.prisma]
-m, --model-name    Outbox model name           [default: OutboxRecord]
-t, --table-name    Database table name         [default: outbox]
    --migration-name  Migration name            [default: add_outbox_table]
-c, --config        Path to configuration file
```


### Manual SQL alternative

```sql
CREATE TABLE outbox (
    id VARCHAR(255) PRIMARY KEY,
    aggregate_id VARCHAR(255) NOT NULL,
    aggregate_type VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    sequence_number BIGINT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0
);
```

## Docker setup

The included `docker-compose.yml` starts PostgreSQL (with `wal2json`), NATS JetStream, and the `outbox-reader` service together.

### Prerequisites

- Docker and Docker Compose v2+
- `Dockerfile.pg` — custom Postgres image with `wal2json` baked in (see the [wal2json section](#3-install-wal2json) above)
- `pg.conf` — PostgreSQL config with `wal_level = logical` (see below)
- `nats.conf` — NATS config with JetStream enabled (see below)

### `pg.conf` (minimum)

```
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

### `nats.conf` (minimum)

```
jetstream {
  store_dir: /data/jetstream
}
```

### Starting everything

```bash
docker compose up -d
```

This starts three services:

| Service | Container | Ports |
|---|---|---|
| PostgreSQL | `ecomm-be-pg` | `5433:5432` |
| NATS | `ecomm-be-nats` | `4222`, `8222` |
| outbox-reader | `outbox-reader` | `4599` (health) |

`outbox-reader` depends on both `db` and `nats` and will restart on failure. Its health is checked via `GET /health` on port `4599`.

### Environment variables for the outbox-reader container

The compose file sets these defaults — override them to match your setup:

| Variable | Default in compose |
|---|---|
| `DATABASE_URL` | `postgres://root:root@ecomm-be-pg:5432/ecomm-be?replication=database` |
| `REPLICATION_SLOT_NAME` | `outbox_slot` |
| `TARGET_NATS_URL` | `nats://ecomm-be-nats:4222` |
| `PORT` | `4599` |
| `LOG_LEVEL` | `info` |

### Running outbox-reader standalone (without compose)

If you already have Postgres and NATS running elsewhere, build and run just the service:

```bash
docker build -f packages/core/Dockerfile -t outbox-reader .

docker run -d \
  -e DATABASE_URL="postgres://user:pass@host:5432/mydb?replication=database" \
  -e REPLICATION_SLOT_NAME="my_slot" \
  -e TARGET_NATS_URL="nats://nats-host:4222" \
  -p 4599:4599 \
  outbox-reader
```

## Configuration

Required environment variables:

- `DATABASE_URL` — PostgreSQL connection string (logical replication must be enabled)
- `REPLICATION_SLOT_NAME` — Name of the PostgreSQL replication slot

NATS configuration:

- `NATS_SERVERS` — NATS server URLs, comma-separated (default: `nats://localhost:4222`)
- `NATS_CONNECTION_NAME` — Connection name (default: `outbox-reader`)
- `NATS_USER`, `NATS_PASSWORD`, `NATS_TOKEN` — Authentication (optional)
- `NATS_MAX_RECONNECT_ATTEMPTS`, `NATS_RECONNECT_TIME_WAIT`, `NATS_TIMEOUT` — Connection tuning (optional)

See `.env.example` and `packages/core/src/config.ts` for all options.

## Testing

```bash
# Run all tests
bun run test

# Run tests for a specific package
cd packages/core && bun test
cd packages/cli && bun test

# Run a single test file
cd packages/core && bun test test/outbox-processor.test.ts
```
