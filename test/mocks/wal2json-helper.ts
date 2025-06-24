import { Wal2Json } from "pg-logical-replication";

export interface MockChangeData {
	kind?: "insert" | "update" | "delete";
	table?: string;
	columnnames?: string[];
	columnvalues?: any[];
}

export class Wal2JsonTestHelper {
	static createMockChange(data: MockChangeData): Wal2Json.Change {
		return {
			kind: data.kind || "insert",
			table: data.table || "outbox",
			schema: "public",
			columnnames: data.columnnames || [],
			columnvalues: data.columnvalues || [],
			columntypes: [],
			columnpositions: [],
			columndefaults: [],
			columnoptionals: [],
		} as Wal2Json.Change;
	}

	static createMockOutput(changes: MockChangeData[]): Wal2Json.Output {
		return {
			nextlsn: "0/1234567",
			origin: 1,
			timestamp: "2023-01-01 00:00:00",
			change: changes.map((change) => this.createMockChange(change)),
		} as unknown as Wal2Json.Output;
	}

	static createOutboxInsert(data: {
		id: string;
		aggregateId: string;
		aggregateType: string;
		eventType: string;
		payload?: any;
		status?: string;
		attempts?: number;
		createdAt?: string;
		processedAt?: string | null;
		sequenceNumber?: number | null;
	}): MockChangeData {
		return {
			kind: "insert",
			table: "outbox",
			columnnames: [
				"id",
				"aggregate_id",
				"aggregate_type",
				"event_type",
				"payload",
				"status",
				"attempts",
				"created_at",
				"processed_at",
				"sequence_number",
			],
			columnvalues: [
				data.id,
				data.aggregateId,
				data.aggregateType,
				data.eventType,
				data.payload || "{}",
				data.status || "PENDING",
				data.attempts || 0,
				data.createdAt || "2023-01-01 00:00:00",
				data.processedAt || null,
				data.sequenceNumber || null,
			],
		};
	}
}
