import fs from "node:fs";
import type { MigrationAdapter } from "./migration-adapter";
import type { SqlMigrationOptions } from "../types/migration-adapter-config";

export class SqlMigrationAdapter implements MigrationAdapter {
  async createMigration(options: SqlMigrationOptions): Promise<void> {
    const tableName = options.tableName ?? "outbox";
    const sql = this.renderSql(tableName);
    if (options.output) {
      fs.writeFileSync(options.output, sql);
      console.log(`Created SQL migration at ${options.output}`);
    } else {
      process.stdout.write(sql);
    }
  }

  private renderSql(tableName: string): string {
    return `CREATE EXTENSION IF NOT EXISTS "pg_uuidv7";

CREATE TABLE IF NOT EXISTS ${tableName} (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  aggregate_id    TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMP,
  sequence_number BIGINT
);

CREATE INDEX IF NOT EXISTS idx_${tableName}_status ON ${tableName}(status);
CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at);
CREATE INDEX IF NOT EXISTS idx_${tableName}_sequence_number ON ${tableName}(sequence_number);
`;
  }
}
