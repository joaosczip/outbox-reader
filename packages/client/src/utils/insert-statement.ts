import { OutboxStatus } from "../models/outbox-status";
import type { OutboxTableOptions } from "../types/adapter-options";
import type { CreateOutboxEvent } from "../types/outbox-event";
import { COLUMN_NAMINGS, type ColumnNaming, applyNamingToTableName, getColumnNames, quoteIdent } from "./column-naming";

export const DEFAULT_TABLE_NAME = "outbox";
export const DEFAULT_COLUMN_NAMING: ColumnNaming = "snake_case";

/**
 * Validates adapter options and builds the parameterised INSERT statement for the
 * outbox table. Bind order: id, aggregateId, aggregateType, eventType, payload, status, attempts.
 */
export function buildInsertStatement(options: OutboxTableOptions = {}): string {
	const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
	const columnNaming = options.columnNaming ?? DEFAULT_COLUMN_NAMING;

	if (typeof tableName !== "string" || tableName.trim() === "") {
		throw new Error(
			`Outbox adapter option tableName must be a non-empty string (got ${JSON.stringify(tableName)})`,
		);
	}
	if (!COLUMN_NAMINGS.includes(columnNaming)) {
		throw new Error(
			`Outbox adapter option columnNaming must be one of: ${COLUMN_NAMINGS.join(", ")} (got ${JSON.stringify(columnNaming)})`,
		);
	}

	const cols = getColumnNames(columnNaming);
	const table = quoteIdent(applyNamingToTableName(tableName, columnNaming));
	const columns = [
		cols.id,
		cols.aggregateId,
		cols.aggregateType,
		cols.eventType,
		cols.payload,
		cols.status,
		cols.attempts,
		cols.createdAt,
	]
		.map(quoteIdent)
		.join(", ");

	return `INSERT INTO ${table} (${columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`;
}

/** Bind values matching {@link buildInsertStatement}'s placeholders. */
export function buildInsertValues(id: string, event: CreateOutboxEvent): unknown[] {
	return [
		id,
		event.aggregateId,
		event.aggregateType,
		event.eventType,
		JSON.stringify(event.payload),
		OutboxStatus.PENDING,
		0,
	];
}
