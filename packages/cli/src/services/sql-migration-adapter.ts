import fs from "node:fs";
import { type ColumnNaming, applyNamingToTableName, getColumnNames } from "../utils/column-naming";
import type { SqlMigrationOptions } from "../types/migration-adapter-config";
import type { MigrationAdapter } from "./migration-adapter";

export class SqlMigrationAdapter implements MigrationAdapter {
	async createMigration(options: SqlMigrationOptions): Promise<void> {
		const naming: ColumnNaming = options.columnNaming ?? "snake_case";
		const rawTableName = options.tableName ?? "outbox";
		const tableName = applyNamingToTableName(rawTableName, naming);
		const cols = getColumnNames(naming);
		const sql = this.renderSql(tableName, cols);
		if (options.output) {
			fs.writeFileSync(options.output, sql);
			console.log(`Created SQL migration at ${options.output}`);
		} else {
			process.stdout.write(sql);
		}
	}

	private renderSql(tableName: string, cols: ReturnType<typeof getColumnNames>): string {
		return `CREATE EXTENSION IF NOT EXISTS "pg_uuidv7";

CREATE TABLE IF NOT EXISTS ${tableName} (
  ${cols.id}              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  ${cols.aggregateId}    VARCHAR(50) NOT NULL,
  ${cols.aggregateType}  VARCHAR(50) NOT NULL,
  ${cols.eventType}      VARCHAR(50) NOT NULL,
  ${cols.payload}         JSONB NOT NULL,
  ${cols.status}          TEXT NOT NULL DEFAULT 'PENDING',
  ${cols.attempts}        INTEGER NOT NULL DEFAULT 0,
  ${cols.createdAt}      TIMESTAMP NOT NULL DEFAULT NOW(),
  ${cols.processedAt}    TIMESTAMP,
  ${cols.sequenceNumber} BIGINT
);

CREATE INDEX IF NOT EXISTS idx_${tableName}_status ON ${tableName}(${cols.status});
CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(${cols.createdAt});
CREATE INDEX IF NOT EXISTS idx_${tableName}_sequence_number ON ${tableName}(${cols.sequenceNumber});
`;
	}
}
