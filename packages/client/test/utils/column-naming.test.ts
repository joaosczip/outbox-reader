import { describe, expect, it } from "bun:test";
import { applyNamingToTableName, getColumnNames, quoteIdent } from "../../src/utils/column-naming";

describe("getColumnNames", () => {
	it("defaults to snake_case", () => {
		expect(getColumnNames()).toEqual(getColumnNames("snake_case"));
	});

	it.each([
		[
			"snake_case",
			{
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
		],
		[
			"camelCase",
			{
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
		],
		[
			"PascalCase",
			{
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
		],
	] as const)("matches the columns the CLI/core use for %s", (naming, expected) => {
		expect(getColumnNames(naming)).toEqual(expected);
	});
});

describe("applyNamingToTableName", () => {
	it.each([
		["outbox", "snake_case", "outbox"],
		["outbox", "camelCase", "outbox"],
		["outbox", "PascalCase", "Outbox"],
		["outbox_events", "snake_case", "outbox_events"],
		["outbox_events", "camelCase", "outboxEvents"],
		["outbox_events", "PascalCase", "OutboxEvents"],
		["Outbox_EVENTS", "snake_case", "outbox_events"],
		["OutboxEvents", "snake_case", "outboxevents"],
	] as const)("transforms %s with %s into %s", (name, naming, expected) => {
		expect(applyNamingToTableName(name, naming)).toBe(expected);
	});
});

describe("quoteIdent", () => {
	it("wraps identifiers in double quotes so mixed case is preserved", () => {
		expect(quoteIdent("AggregateId")).toBe('"AggregateId"');
	});

	it("escapes embedded double quotes", () => {
		expect(quoteIdent('out"box')).toBe('"out""box"');
		expect(quoteIdent('x"; DROP TABLE users; --')).toBe('"x""; DROP TABLE users; --"');
	});
});
