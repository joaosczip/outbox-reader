import fs from "node:fs";
import type { SqlMigrationOptions } from "../types/migration-adapter-config";
import { type ColumnNaming, applyNamingToTableName, getColumnNames } from "../utils/column-naming";
import type { MigrationAdapter } from "./migration-adapter";

/** Quotes a PostgreSQL identifier, escaping embedded double quotes. */
const quoteIdent = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

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
		// Identifiers are quoted so mixed-case names (camelCase/PascalCase) are preserved
		// instead of being folded to lowercase by PostgreSQL.
		const q = quoteIdent;
		const t = q(tableName);
		return `CREATE EXTENSION IF NOT EXISTS "pg_uuidv7";

CREATE TABLE IF NOT EXISTS ${t} (
  ${q(cols.id)} UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  ${q(cols.aggregateId)} VARCHAR(50) NOT NULL,
  ${q(cols.aggregateType)} VARCHAR(50) NOT NULL,
  ${q(cols.eventType)} VARCHAR(50) NOT NULL,
  ${q(cols.payload)} JSONB NOT NULL,
  ${q(cols.status)} TEXT NOT NULL DEFAULT 'PENDING',
  ${q(cols.attempts)} INTEGER NOT NULL DEFAULT 0,
  ${q(cols.createdAt)} TIMESTAMP NOT NULL DEFAULT NOW(),
  ${q(cols.processedAt)} TIMESTAMP,
  ${q(cols.requeuedAt)} TIMESTAMP,
  ${q(cols.sequenceNumber)} BIGINT
);

-- Partial indexes for status-based reads, the per-aggregate predecessor check, and retention.
-- PENDING/FAILED indexes stay small. Becoming PROCESSED adds one entry to the PROCESSED index.
-- The null processed_at purge fallback has no index of its own.
CREATE INDEX IF NOT EXISTS ${q(`idx_${tableName}_pending_created_at`)} ON ${t}(${q(cols.createdAt)}) WHERE ${q(cols.status)} = 'PENDING';
CREATE INDEX IF NOT EXISTS ${q(`idx_${tableName}_failed_created_at`)} ON ${t}(${q(cols.createdAt)}) WHERE ${q(cols.status)} = 'FAILED';
CREATE INDEX IF NOT EXISTS ${q(`idx_${tableName}_pending_aggregate_order`)} ON ${t}(${q(cols.aggregateId)}, ${q(cols.createdAt)}, ${q(cols.id)}) WHERE ${q(cols.status)} = 'PENDING';
CREATE INDEX IF NOT EXISTS ${q(`idx_${tableName}_failed_aggregate_order`)} ON ${t}(${q(cols.aggregateId)}, ${q(cols.createdAt)}, ${q(cols.id)}) WHERE ${q(cols.status)} = 'FAILED';
CREATE INDEX IF NOT EXISTS ${q(`idx_${tableName}_processed_processed_at`)} ON ${t}(${q(cols.processedAt)}) WHERE ${q(cols.status)} = 'PROCESSED';
CREATE INDEX IF NOT EXISTS ${q(`idx_${tableName}_dead_created_at`)} ON ${t}(${q(cols.createdAt)}) WHERE ${q(cols.status)} = 'DEAD';
`;
	}
}
