import { describe, expect, it } from "bun:test";
import { applyNamingToTableName, getColumnNames } from "../src/utils/column-naming";

describe("getColumnNames", () => {
	describe("snake_case (default)", () => {
		it("returns snake_case column names", () => {
			const cols = getColumnNames("snake_case");
			expect(cols.aggregateId).toBe("aggregate_id");
			expect(cols.aggregateType).toBe("aggregate_type");
			expect(cols.eventType).toBe("event_type");
			expect(cols.sequenceNumber).toBe("sequence_number");
			expect(cols.createdAt).toBe("created_at");
			expect(cols.processedAt).toBe("processed_at");
		});

		it("keeps unchanged columns the same", () => {
			const cols = getColumnNames("snake_case");
			expect(cols.id).toBe("id");
			expect(cols.payload).toBe("payload");
			expect(cols.status).toBe("status");
			expect(cols.attempts).toBe("attempts");
		});

		it("defaults to snake_case when no argument is given", () => {
			const defaultCols = getColumnNames();
			const snakeCols = getColumnNames("snake_case");
			expect(defaultCols).toEqual(snakeCols);
		});
	});

	describe("camelCase", () => {
		it("returns camelCase column names", () => {
			const cols = getColumnNames("camelCase");
			expect(cols.aggregateId).toBe("aggregateId");
			expect(cols.aggregateType).toBe("aggregateType");
			expect(cols.eventType).toBe("eventType");
			expect(cols.sequenceNumber).toBe("sequenceNumber");
			expect(cols.createdAt).toBe("createdAt");
			expect(cols.processedAt).toBe("processedAt");
		});

		it("keeps unchanged columns the same", () => {
			const cols = getColumnNames("camelCase");
			expect(cols.id).toBe("id");
			expect(cols.payload).toBe("payload");
			expect(cols.status).toBe("status");
			expect(cols.attempts).toBe("attempts");
		});
	});

	describe("PascalCase", () => {
		it("returns PascalCase column names", () => {
			const cols = getColumnNames("PascalCase");
			expect(cols.aggregateId).toBe("AggregateId");
			expect(cols.aggregateType).toBe("AggregateType");
			expect(cols.eventType).toBe("EventType");
			expect(cols.sequenceNumber).toBe("SequenceNumber");
			expect(cols.createdAt).toBe("CreatedAt");
			expect(cols.processedAt).toBe("ProcessedAt");
		});

		it("keeps unchanged columns the same", () => {
			const cols = getColumnNames("PascalCase");
			expect(cols.id).toBe("id");
			expect(cols.payload).toBe("payload");
			expect(cols.status).toBe("status");
			expect(cols.attempts).toBe("attempts");
		});
	});
});

describe("applyNamingToTableName", () => {
	describe("snake_case", () => {
		it("lowercases single-word names", () => {
			expect(applyNamingToTableName("outbox", "snake_case")).toBe("outbox");
			expect(applyNamingToTableName("OUTBOX", "snake_case")).toBe("outbox");
		});

		it("preserves underscore-separated names as lowercase", () => {
			expect(applyNamingToTableName("my_outbox", "snake_case")).toBe("my_outbox");
		});
	});

	describe("camelCase", () => {
		it("lowercases first letter of single-word name", () => {
			expect(applyNamingToTableName("outbox", "camelCase")).toBe("outbox");
			expect(applyNamingToTableName("Outbox", "camelCase")).toBe("outbox");
		});

		it("converts underscore-separated name to camelCase", () => {
			expect(applyNamingToTableName("my_outbox", "camelCase")).toBe("myOutbox");
		});
	});

	describe("PascalCase", () => {
		it("capitalizes first letter of single-word name", () => {
			expect(applyNamingToTableName("outbox", "PascalCase")).toBe("Outbox");
		});

		it("converts underscore-separated name to PascalCase", () => {
			expect(applyNamingToTableName("my_outbox", "PascalCase")).toBe("MyOutbox");
		});
	});
});
