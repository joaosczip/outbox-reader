export type ColumnNaming = "snake_case" | "camelCase" | "PascalCase";

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
