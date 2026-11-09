/**
 * Naming rules for the outbox table and its columns.
 *
 * These MUST stay identical to `packages/cli/src/utils/column-naming.ts` (used by
 * `outy create schema|migration --table-name --column-naming`) and
 * `packages/core/src/utils/column-naming.ts` (used by core's `TABLE_NAME` /
 * `COLUMN_NAMING`), otherwise the client would write to a table/columns the
 * migration did not create or the replication service does not read.
 */
export type ColumnNaming = "snake_case" | "camelCase" | "PascalCase";

export const COLUMN_NAMINGS: readonly ColumnNaming[] = ["snake_case", "camelCase", "PascalCase"];

export interface OutboxColumnNames {
	id: string;
	aggregateId: string;
	aggregateType: string;
	eventType: string;
	payload: string;
	sequenceNumber: string;
	createdAt: string;
	processedAt: string;
	status: string;
	attempts: string;
}

const COLUMN_NAMES: Record<ColumnNaming, OutboxColumnNames> = {
	snake_case: {
		id: "id",
		aggregateId: "aggregate_id",
		aggregateType: "aggregate_type",
		eventType: "event_type",
		payload: "payload",
		sequenceNumber: "sequence_number",
		createdAt: "created_at",
		processedAt: "processed_at",
		status: "status",
		attempts: "attempts",
	},
	camelCase: {
		id: "id",
		aggregateId: "aggregateId",
		aggregateType: "aggregateType",
		eventType: "eventType",
		payload: "payload",
		sequenceNumber: "sequenceNumber",
		createdAt: "createdAt",
		processedAt: "processedAt",
		status: "status",
		attempts: "attempts",
	},
	PascalCase: {
		id: "id",
		aggregateId: "AggregateId",
		aggregateType: "AggregateType",
		eventType: "EventType",
		payload: "payload",
		sequenceNumber: "SequenceNumber",
		createdAt: "CreatedAt",
		processedAt: "ProcessedAt",
		status: "status",
		attempts: "attempts",
	},
};

export function getColumnNames(naming: ColumnNaming = "snake_case"): OutboxColumnNames {
	return COLUMN_NAMES[naming];
}

/** Transforms an `_`-separated table name into the physical name for the given naming (same rule as CLI/core). */
export function applyNamingToTableName(name: string, naming: ColumnNaming): string {
	const words = name.split("_");
	switch (naming) {
		case "snake_case":
			return words.map((w) => w.toLowerCase()).join("_");
		case "camelCase":
			return (
				words[0].toLowerCase() +
				words
					.slice(1)
					.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
					.join("")
			);
		case "PascalCase":
			return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
	}
}

/**
 * Quotes a PostgreSQL identifier, escaping embedded double quotes. Quoting keeps
 * mixed-case names (camelCase/PascalCase) intact instead of folding them to lowercase.
 */
export const quoteIdent = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
