import { beforeEach, describe, expect, it } from "bun:test";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { OutboxRepository, quoteIdent } from "../src/outbox-repository";
import type { RetryConfig } from "../src/types";
import type { ColumnNaming } from "../src/utils/column-naming";
import { MockPgPool, normalizeSql } from "./mocks/mock-pg-pool";

const retryConfig: RetryConfig = {
	numOfAttempts: 1,
	startingDelayInMs: 1,
	maxDelayInMs: 1,
	jitter: "none",
};

const noRetry = () => false;

const makeRepository = (pool: MockPgPool, columnNaming?: ColumnNaming, tableName?: string) =>
	new OutboxRepository({ pool: pool.asPool(), retryConfig, columnNaming, tableName });

const camelRow = (id: string) => ({
	id,
	aggregateId: `agg-${id}`,
	aggregateType: "User",
	eventType: "user.created",
	payload: { foo: "bar" },
	sequenceNumber: 7,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	processedAt: null,
	status: "FAILED",
	attempts: 2,
});

describe("quoteIdent", () => {
	it("wraps identifiers in double quotes", () => {
		expect(quoteIdent("aggregateId")).toBe('"aggregateId"');
	});

	it("escapes embedded double quotes", () => {
		expect(quoteIdent('we"ird')).toBe('"we""ird"');
	});
});

describe("OutboxRepository", () => {
	let pool: MockPgPool;

	beforeEach(() => {
		pool = new MockPgPool();
	});

	describe("identifier quoting (regression: camelCase columns folded to lowercase)", () => {
		it("quotes camelCase column and table identifiers in findUnprocessedById", async () => {
			const repository = makeRepository(pool, "camelCase", "my_outbox");

			await repository.findUnprocessedById("1");

			const sql = normalizeSql(pool.lastCall().text);
			expect(sql).toContain(
				'SELECT "id", "aggregateId", "aggregateType", "eventType", "payload", "sequenceNumber",',
			);
			expect(sql).toContain('"createdAt", "processedAt", "status", "attempts"');
			expect(sql).toContain('FROM "myOutbox"');
			expect(sql).toContain(`WHERE "id" = $1 AND "status" IN ('PENDING', 'FAILED')`);
			expect(sql).not.toMatch(/[^"]aggregateId[^"]/);
			expect(pool.lastCall().params).toEqual(["1"]);
		});

		it("quotes PascalCase identifiers in create", async () => {
			const repository = makeRepository(pool, "PascalCase");
			pool.enqueueResult({ rows: [{ id: "abc" }] });

			const id = await repository.create({
				id: "abc",
				aggregateId: "a",
				aggregateType: "T",
				eventType: "e",
				payload: {},
				sequenceNumber: 1,
				status: "PENDING",
			});

			const sql = normalizeSql(pool.lastCall().text);
			expect(id).toBe("abc");
			expect(sql).toContain('INSERT INTO "Outbox"');
			expect(sql).toContain(
				'"id", "AggregateId", "AggregateType", "EventType", "payload", "SequenceNumber", "status", "attempts", "CreatedAt"',
			);
			expect(sql).toContain('RETURNING "id"');
			expect(pool.lastCall().params).toEqual(["abc", "a", "T", "e", {}, 1, "PENDING", 0]);
		});

		it("quotes identifiers in delete", async () => {
			const repository = makeRepository(pool, "camelCase");

			await repository.delete("1", "FAILED");

			expect(normalizeSql(pool.lastCall().text)).toBe('DELETE FROM "outbox" WHERE "id" = $1 AND "status" = $2');
			expect(pool.lastCall().params).toEqual(["1", "FAILED"]);
		});

		it("keeps snake_case identifiers working when quoted", async () => {
			const repository = makeRepository(pool);

			await repository.findUnprocessedByIds(["1", "2"]);

			const sql = normalizeSql(pool.lastCall().text);
			expect(sql).toContain('"aggregate_id"');
			expect(sql).toContain('FROM "outbox"');
			expect(sql).toContain('WHERE "id" = ANY($1)');
			expect(pool.lastCall().params).toEqual([["1", "2"]]);
		});
	});

	describe("findFailedEvents", () => {
		it("orders by created_at ascending and limits", async () => {
			const repository = makeRepository(pool);

			await repository.findFailedEvents(25);

			const sql = normalizeSql(pool.lastCall().text);
			expect(sql).toContain(`WHERE "status" = 'FAILED' ORDER BY "created_at" ASC LIMIT $1`);
			expect(pool.lastCall().params).toEqual([25]);
		});

		it("returns mapped OutboxRecords for camelCase rows", async () => {
			const repository = makeRepository(pool, "camelCase");
			pool.enqueueResult({ rows: [camelRow("1")] });

			const records = await repository.findFailedEvents();

			expect(normalizeSql(pool.lastCall().text)).toContain('ORDER BY "createdAt" ASC');
			expect(records).toHaveLength(1);
			expect(records[0]).toBeInstanceOf(OutboxRecord);
			expect(records[0]).toMatchObject({
				id: "1",
				aggregateId: "agg-1",
				aggregateType: "User",
				eventType: "user.created",
				payload: { foo: "bar" },
				sequenceNumber: 7,
				status: OutboxStatus.FAILED,
				attempts: 2,
			});
			expect(records[0].createdAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
			expect(records[0].processedAt).toBeUndefined();
		});

		it("returns mapped OutboxRecords for snake_case rows", async () => {
			const repository = makeRepository(pool);
			pool.enqueueResult({
				rows: [
					{
						id: "9",
						aggregate_id: "agg-9",
						aggregate_type: "Order",
						event_type: "order.placed",
						payload: {},
						sequence_number: 3,
						created_at: new Date(),
						processed_at: null,
						status: "FAILED",
						attempts: 1,
					},
				],
			});

			const [record] = await repository.findFailedEvents();

			expect(record).toMatchObject({
				id: "9",
				aggregateId: "agg-9",
				aggregateType: "Order",
				eventType: "order.placed",
				sequenceNumber: 3,
				attempts: 1,
			});
		});
	});

	describe("markManyAsFailed", () => {
		it("issues a single query using ANY($1)", async () => {
			const repository = makeRepository(pool, "camelCase");

			await repository.markManyAsFailed({ ids: ["1", "2", "3"] });

			expect(pool.query).toHaveBeenCalledTimes(1);
			const sql = normalizeSql(pool.lastCall().text);
			expect(sql).toBe(
				`UPDATE "outbox" SET "status" = 'FAILED', "attempts" = "attempts" + 1 WHERE "id" = ANY($1)`,
			);
			expect(pool.lastCall().params).toEqual([["1", "2", "3"]]);
		});

		it("does not query when ids is empty", async () => {
			const repository = makeRepository(pool);

			await repository.markManyAsFailed({ ids: [] });

			expect(pool.query).not.toHaveBeenCalled();
		});
	});

	describe("markAsProcessed", () => {
		it("returns true when a row was updated", async () => {
			const repository = makeRepository(pool, "camelCase");
			pool.enqueueResult({ rowCount: 1 });

			const updated = await repository.markAsProcessed({
				id: "1",
				sequenceNumber: 10,
				attempts: 2,
				retry: noRetry,
			});

			expect(updated).toBe(true);
			expect(normalizeSql(pool.lastCall().text)).toBe(
				`UPDATE "outbox" SET "status" = 'PROCESSED', "processedAt" = NOW(), "attempts" = "attempts" + 1, "sequenceNumber" = $1 WHERE "id" = $2 AND "attempts" = $3`,
			);
			expect(pool.lastCall().params).toEqual([10, "1", 2]);
		});

		it("returns false on an optimistic-lock miss (rowCount 0)", async () => {
			const repository = makeRepository(pool);
			pool.enqueueResult({ rowCount: 0 });

			const updated = await repository.markAsProcessed({
				id: "1",
				sequenceNumber: 10,
				attempts: 2,
				retry: noRetry,
			});

			expect(updated).toBe(false);
		});

		it("propagates DB errors after retries are exhausted", async () => {
			const repository = makeRepository(pool);
			pool.query.mockImplementationOnce(async () => {
				throw new Error("db down");
			});

			await expect(
				repository.markAsProcessed({ id: "1", sequenceNumber: 10, attempts: 2, retry: noRetry }),
			).rejects.toThrow("db down");
		});
	});

	describe("markAsFailed", () => {
		it("returns true when a row was updated", async () => {
			const repository = makeRepository(pool, "PascalCase");
			pool.enqueueResult({ rowCount: 1 });

			const updated = await repository.markAsFailed({ id: "1", attempts: 0, retry: noRetry });

			expect(updated).toBe(true);
			expect(normalizeSql(pool.lastCall().text)).toBe(
				`UPDATE "Outbox" SET "status" = 'FAILED', "attempts" = "attempts" + 1 WHERE "id" = $1 AND "attempts" = $2`,
			);
			expect(pool.lastCall().params).toEqual(["1", 0]);
		});

		it("returns false on an optimistic-lock miss (rowCount 0)", async () => {
			const repository = makeRepository(pool);
			pool.enqueueResult({ rowCount: 0 });

			expect(await repository.markAsFailed({ id: "1", attempts: 0, retry: noRetry })).toBe(false);
		});
	});

	describe("markAsDead", () => {
		it("sets the terminal DEAD status with an optimistic lock on attempts and unprocessed status", async () => {
			const repository = makeRepository(pool, "camelCase");
			pool.enqueueResult({ rowCount: 1 });

			const updated = await repository.markAsDead({ id: "1", attempts: 5, retry: noRetry });

			expect(updated).toBe(true);
			expect(normalizeSql(pool.lastCall().text)).toBe(
				`UPDATE "outbox" SET "status" = 'DEAD', "attempts" = "attempts" + $3 WHERE "id" = $1 AND "attempts" = $2 AND "status" IN ('PENDING', 'FAILED')`,
			);
			expect(pool.lastCall().params).toEqual(["1", 5, 0]);
		});

		it("increments attempts when countAttempt is true", async () => {
			const repository = makeRepository(pool, "PascalCase");
			pool.enqueueResult({ rowCount: 1 });

			await repository.markAsDead({ id: "1", attempts: 4, retry: noRetry, countAttempt: true });

			expect(normalizeSql(pool.lastCall().text)).toContain(`UPDATE "Outbox" SET "status" = 'DEAD'`);
			expect(pool.lastCall().params).toEqual(["1", 4, 1]);
		});

		it("returns false on an optimistic-lock miss (rowCount 0)", async () => {
			const repository = makeRepository(pool);
			pool.enqueueResult({ rowCount: 0 });

			expect(await repository.markAsDead({ id: "1", attempts: 5, retry: noRetry })).toBe(false);
		});

		it("propagates DB errors after retries are exhausted", async () => {
			const repository = makeRepository(pool);
			pool.query.mockImplementationOnce(async () => {
				throw new Error("db down");
			});

			await expect(repository.markAsDead({ id: "1", attempts: 5, retry: noRetry })).rejects.toThrow("db down");
		});
	});

	describe("unprocessed finders exclude DEAD records", () => {
		it("findUnprocessedById only selects PENDING/FAILED", async () => {
			const repository = makeRepository(pool);

			await repository.findUnprocessedById("1");

			const sql = normalizeSql(pool.lastCall().text);
			expect(sql).toContain(`"status" IN ('PENDING', 'FAILED')`);
			expect(sql).not.toContain("DEAD");
		});

		it("findUnprocessedByIds only selects PENDING/FAILED", async () => {
			const repository = makeRepository(pool);

			await repository.findUnprocessedByIds(["1", "2"]);

			const sql = normalizeSql(pool.lastCall().text);
			expect(sql).toContain(`"status" IN ('PENDING', 'FAILED')`);
			expect(sql).not.toContain("DEAD");
		});

		it("findFailedEvents only selects FAILED (so DEAD records end the reprocess loop)", async () => {
			const repository = makeRepository(pool);

			await repository.findFailedEvents(10);

			expect(normalizeSql(pool.lastCall().text)).toContain(`WHERE "status" = 'FAILED'`);
		});
	});

	describe("onTransaction", () => {
		it("runs quoted queries on the transaction client and commits", async () => {
			const repository = makeRepository(pool, "camelCase");

			await repository.onTransaction(async (tx) => {
				await tx.delete("1", "FAILED");
			});

			const texts = pool.calls.map((c) => normalizeSql(c.text));
			expect(texts).toEqual(["BEGIN", 'DELETE FROM "outbox" WHERE "id" = $1 AND "status" = $2', "COMMIT"]);
			expect(pool.release).toHaveBeenCalledTimes(1);
		});
	});
});

describe("OutboxRepository.findStalePendingEvents", () => {
	let pool: MockPgPool;

	beforeEach(() => {
		pool = new MockPgPool();
	});

	it("selects PENDING records OLDER than the threshold (regression: used to select recent ones)", async () => {
		const repository = makeRepository(pool, "camelCase");

		await repository.findStalePendingEvents({ olderThanMinutes: 15, limit: 50 });

		const sql = normalizeSql(pool.lastCall().text);
		expect(sql).toContain('FROM "outbox"');
		expect(sql).toContain(`WHERE "status" = 'PENDING' AND "createdAt" < NOW() - make_interval(mins => $1::int)`);
		expect(sql).not.toContain(">=");
		expect(sql).toContain('ORDER BY "createdAt" ASC LIMIT $2');
		expect(pool.lastCall().params).toEqual([15, 50]);
	});

	it("uses snake_case quoted identifiers by default", async () => {
		const repository = makeRepository(pool);

		await repository.findStalePendingEvents({ olderThanMinutes: 10, limit: 100 });

		const sql = normalizeSql(pool.lastCall().text);
		expect(sql).toContain(`WHERE "status" = 'PENDING' AND "created_at" < NOW() - make_interval(mins => $1::int)`);
		expect(sql).toContain('ORDER BY "created_at" ASC LIMIT $2');
	});

	it("maps rows to OutboxRecord instances", async () => {
		const repository = makeRepository(pool, "camelCase");
		pool.enqueueResult({
			rows: [
				{ ...camelRow("1"), status: "PENDING" },
				{ ...camelRow("2"), status: "PENDING" },
			],
		});

		const records = await repository.findStalePendingEvents({ olderThanMinutes: 10, limit: 100 });

		expect(records).toHaveLength(2);
		expect(records[0]).toBeInstanceOf(OutboxRecord);
		expect(records[0]).toMatchObject({
			id: "1",
			aggregateId: "agg-1",
			aggregateType: "User",
			eventType: "user.created",
			payload: { foo: "bar" },
			sequenceNumber: 7,
			status: OutboxStatus.PENDING,
			attempts: 2,
		});
		expect(records[0].createdAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
		expect(records[1].id).toBe("2");
	});
});
