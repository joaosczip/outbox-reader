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
			expect(sql).toContain(`WHERE "status" = 'FAILED' ORDER BY "created_at" ASC, "id" ASC LIMIT $1`);
			expect(pool.lastCall().params).toEqual([25]);
		});

		it("returns mapped OutboxRecords for camelCase rows", async () => {
			const repository = makeRepository(pool, "camelCase");
			pool.enqueueResult({ rows: [camelRow("1")] });

			const records = await repository.findFailedEvents();

			expect(normalizeSql(pool.lastCall().text)).toContain('ORDER BY "createdAt" ASC, "id" ASC');
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
		expect(sql).toContain(`AND ("requeuedAt" IS NULL OR "requeuedAt" < NOW() - make_interval(mins => $1::int))`);
		expect(sql).not.toContain(">=");
		expect(sql).not.toContain("COALESCE");
		expect(sql).toContain('ORDER BY "createdAt" ASC, "id" ASC LIMIT $2');
		expect(pool.lastCall().params).toEqual([15, 50]);
	});

	it("uses snake_case quoted identifiers by default", async () => {
		const repository = makeRepository(pool);

		await repository.findStalePendingEvents({ olderThanMinutes: 10, limit: 100 });

		const sql = normalizeSql(pool.lastCall().text);
		expect(sql).toContain(
			`WHERE "status" = 'PENDING' AND "created_at" < NOW() - make_interval(mins => $1::int) AND ("requeued_at" IS NULL OR "requeued_at" < NOW() - make_interval(mins => $1::int)) ORDER BY "created_at" ASC, "id" ASC LIMIT $2`,
		);
		expect(sql).not.toContain("COALESCE");
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

describe("OutboxRepository aggregate order predicates", () => {
	let pool: MockPgPool;

	beforeEach(() => {
		pool = new MockPgPool();
	});

	const record = new OutboxRecord({
		id: "11111111-1111-1111-1111-111111111111",
		aggregateId: "agg-1",
		aggregateType: "User",
		eventType: "user.created",
		payload: {},
		createdAt: "2020-01-02T00:00:00.000Z",
		status: OutboxStatus.PENDING,
	});

	it("hasOlderPendingOrFailed unions literal PENDING and FAILED branches and returns false when none match", async () => {
		const repository = makeRepository(pool);

		expect(await repository.hasOlderPendingOrFailed(record)).toBe(false);

		const sql = normalizeSql(pool.lastCall().text);
		expect(sql).toContain(`"status" = 'PENDING'`);
		expect(sql).toContain(`"status" = 'FAILED'`);
		expect(sql).toContain("UNION ALL");
		expect(sql).toContain(`("created_at", "id") < ($2::timestamp, $3::uuid)`);
		expect(sql).toContain(`"aggregate_id" = $1`);
		expect(sql).toContain("LIMIT 1");
		expect(sql).not.toContain("ANY");
		expect(sql).not.toContain(" IN ");
		expect(sql).not.toContain("DEAD");
		expect(pool.lastCall().params).toEqual(["agg-1", record.createdAt, record.id]);
	});

	it("quotes camelCase identifiers in the predecessor check", async () => {
		const repository = makeRepository(pool, "camelCase", "my_outbox");

		await repository.hasOlderPendingOrFailed(record);

		const sql = normalizeSql(pool.lastCall().text);
		expect(sql).toContain(`FROM "myOutbox"`);
		expect(sql).toContain(
			`"status" = 'PENDING' AND "aggregateId" = $1 AND ("createdAt", "id") < ($2::timestamp, $3::uuid)`,
		);
		expect(sql).toContain(
			`"status" = 'FAILED' AND "aggregateId" = $1 AND ("createdAt", "id") < ($2::timestamp, $3::uuid)`,
		);
	});

	it("returns true when a predecessor row exists", async () => {
		const repository = makeRepository(pool);
		pool.enqueueResult({ rows: [{ "?column?": 1 }], rowCount: 1 });

		expect(await repository.hasOlderPendingOrFailed(record)).toBe(true);
	});

	it("findNextReadyPending returns null when the aggregate has no PENDING row", async () => {
		const repository = makeRepository(pool);

		expect(await repository.findNextReadyPending("agg-1")).toBeNull();

		const sql = normalizeSql(pool.lastCall().text);
		expect(sql).toContain(`WHERE "status" = 'PENDING' AND "aggregate_id" = $1`);
		expect(sql).toContain(`ORDER BY "created_at" ASC, "id" ASC LIMIT 1`);
		expect(pool.calls).toHaveLength(1);
		expect(pool.lastCall().params).toEqual(["agg-1"]);
	});

	it("findNextReadyPending returns the oldest PENDING row when no older FAILED sibling exists", async () => {
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
					created_at: new Date("2020-01-01T00:00:00.000Z"),
					processed_at: null,
					status: "PENDING",
					attempts: 0,
				},
			],
		});
		pool.enqueueResult({ rows: [], rowCount: 0 });

		const next = await repository.findNextReadyPending("agg-9");

		expect(next).toMatchObject({ id: "9", aggregateId: "agg-9", status: OutboxStatus.PENDING });
		expect(pool.calls).toHaveLength(2);
		expect(normalizeSql(pool.calls[1].text)).toContain(`"status" = 'FAILED'`);
	});

	it("findNextReadyPending returns null when an older FAILED sibling blocks the oldest PENDING row", async () => {
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
					created_at: new Date("2020-01-02T00:00:00.000Z"),
					processed_at: null,
					status: "PENDING",
					attempts: 0,
				},
			],
		});
		pool.enqueueResult({ rows: [{ "?column?": 1 }], rowCount: 1 });

		expect(await repository.findNextReadyPending("agg-9")).toBeNull();
	});
});

describe("OutboxRepository.deleteProcessedBefore", () => {
	let pool: MockPgPool;

	beforeEach(() => {
		pool = new MockPgPool();
	});

	const processedHotPath = `
		DELETE FROM "outbox"
		WHERE ctid = ANY (ARRAY(
			SELECT ctid FROM "outbox"
			WHERE "status" = 'PROCESSED'
			  AND "processed_at" IS NOT NULL
			  AND "processed_at" < NOW() - make_interval(days => $1::int)
			  AND "created_at" < NOW() - make_interval(days => $1::int)
			ORDER BY "processed_at" ASC
			LIMIT $2
		))
	`;

	const processedNullFallback = `
		DELETE FROM "outbox"
		WHERE ctid = ANY (ARRAY(
			SELECT ctid FROM "outbox"
			WHERE "status" = 'PROCESSED'
			  AND "processed_at" IS NULL
			  AND "created_at" < NOW() - make_interval(days => $1::int)
			ORDER BY "created_at" ASC
			LIMIT $2
		))
	`;

	it("deletes PROCESSED rows on the processed_at index and skips the null fallback when the batch is full", async () => {
		const repository = makeRepository(pool);
		pool.enqueueResult({ rowCount: 500 });

		const deleted = await repository.deleteProcessedBefore({
			olderThanDays: 7,
			limit: 500,
			statuses: [OutboxStatus.PROCESSED],
		});

		expect(deleted).toBe(500);
		expect(pool.calls).toHaveLength(1);
		expect(normalizeSql(pool.calls[0].text)).toBe(normalizeSql(processedHotPath));
		expect(pool.calls[0].params).toEqual([7, 500]);
		expect(pool.calls[0].text).not.toContain("status = ANY");
	});

	it("follows a short PROCESSED batch with the null processed_at fallback and returns the sum", async () => {
		const repository = makeRepository(pool);
		pool.enqueueResult({ rowCount: 4 });
		pool.enqueueResult({ rowCount: 2 });

		const deleted = await repository.deleteProcessedBefore({
			olderThanDays: 7,
			limit: 10,
			statuses: ["PROCESSED"],
		});

		expect(deleted).toBe(6);
		expect(pool.calls).toHaveLength(2);
		expect(normalizeSql(pool.calls[0].text)).toBe(normalizeSql(processedHotPath));
		expect(pool.calls[0].params).toEqual([7, 10]);
		expect(normalizeSql(pool.calls[1].text)).toBe(normalizeSql(processedNullFallback));
		expect(pool.calls[1].params).toEqual([7, 6]);
	});

	it("runs the null processed_at fallback with the full limit when the hot path deletes nothing", async () => {
		const repository = makeRepository(pool);
		pool.enqueueResult({ rowCount: null });
		pool.enqueueResult({ rowCount: 3 });

		const deleted = await repository.deleteProcessedBefore({
			olderThanDays: 14,
			limit: 100,
			statuses: [OutboxStatus.PROCESSED],
		});

		expect(deleted).toBe(3);
		expect(pool.calls).toHaveLength(2);
		expect(pool.calls[1].params).toEqual([14, 100]);
		expect(normalizeSql(pool.calls[1].text)).toContain(`"processed_at" IS NULL`);
	});

	it("deletes DEAD rows with a literal status so the created_at partial index can match", async () => {
		const repository = makeRepository(pool);
		pool.enqueueResult({ rowCount: 8 });

		const deleted = await repository.deleteProcessedBefore({
			olderThanDays: 30,
			limit: 10,
			statuses: [OutboxStatus.DEAD],
		});

		expect(deleted).toBe(8);
		expect(pool.calls).toHaveLength(1);
		expect(normalizeSql(pool.calls[0].text)).toBe(
			normalizeSql(`
				DELETE FROM "outbox"
				WHERE ctid = ANY (ARRAY(
					SELECT ctid FROM "outbox"
					WHERE "status" = 'DEAD'
					  AND "created_at" < NOW() - make_interval(days => $1::int)
					  AND COALESCE("processed_at", "created_at") < NOW() - make_interval(days => $1::int)
					ORDER BY "created_at" ASC
					LIMIT $2
				))
			`),
		);
		expect(pool.calls[0].params).toEqual([30, 10]);
		expect(pool.calls[0].text).not.toContain("status = ANY");
	});

	it("quotes camelCase identifiers for the DEAD purge", async () => {
		const repository = makeRepository(pool, "camelCase", "my_outbox");
		pool.enqueueResult({ rowCount: 1 });

		await repository.deleteProcessedBefore({ olderThanDays: 30, limit: 10, statuses: [OutboxStatus.DEAD] });

		expect(normalizeSql(pool.lastCall().text)).toBe(
			normalizeSql(`
				DELETE FROM "myOutbox"
				WHERE ctid = ANY (ARRAY(
					SELECT ctid FROM "myOutbox"
					WHERE "status" = 'DEAD'
					  AND "createdAt" < NOW() - make_interval(days => $1::int)
					  AND COALESCE("processedAt", "createdAt") < NOW() - make_interval(days => $1::int)
					ORDER BY "createdAt" ASC
					LIMIT $2
				))
			`),
		);
		expect(pool.lastCall().params).toEqual([30, 10]);
	});

	it("purges each requested status in order and sums every statement", async () => {
		const repository = makeRepository(pool, "PascalCase");
		pool.enqueueResult({ rowCount: 10 });
		pool.enqueueResult({ rowCount: 1 });
		pool.enqueueResult({ rowCount: 2 });

		const deleted = await repository.deleteProcessedBefore({
			olderThanDays: 9,
			limit: 10,
			statuses: [OutboxStatus.DEAD, OutboxStatus.PROCESSED],
		});

		expect(deleted).toBe(13);
		expect(pool.calls).toHaveLength(3);
		expect(normalizeSql(pool.calls[0].text)).toContain(`"status" = 'DEAD'`);
		expect(normalizeSql(pool.calls[0].text)).toContain(`ORDER BY "CreatedAt" ASC`);
		expect(pool.calls[0].params).toEqual([9, 10]);
		expect(normalizeSql(pool.calls[1].text)).toContain(`"status" = 'PROCESSED'`);
		expect(normalizeSql(pool.calls[1].text)).toContain(`"ProcessedAt" IS NOT NULL`);
		expect(normalizeSql(pool.calls[1].text)).toContain(`ORDER BY "ProcessedAt" ASC`);
		expect(pool.calls[1].params).toEqual([9, 10]);
		expect(normalizeSql(pool.calls[2].text)).toContain(`"ProcessedAt" IS NULL`);
		expect(normalizeSql(pool.calls[2].text)).toContain(`ORDER BY "CreatedAt" ASC`);
		expect(pool.calls[2].params).toEqual([9, 9]);
	});

	it("does not query when no status is given", async () => {
		const repository = makeRepository(pool);

		expect(await repository.deleteProcessedBefore({ olderThanDays: 7, limit: 100, statuses: [] })).toBe(0);
		expect(pool.calls).toHaveLength(0);
	});

	it.each(["PENDING", "FAILED", "BOGUS"])(
		"refuses to purge non-terminal status %s without querying",
		async (status) => {
			const repository = makeRepository(pool);

			await expect(
				repository.deleteProcessedBefore({ olderThanDays: 7, limit: 100, statuses: ["PROCESSED", status] }),
			).rejects.toThrow(/only PROCESSED and DEAD/);
			expect(pool.calls).toHaveLength(0);
		},
	);

	it.each([
		{ olderThanDays: 0, limit: 10 },
		{ olderThanDays: 1.5, limit: 10 },
		{ olderThanDays: 7, limit: 0 },
	])("rejects invalid bounds %o without querying", async ({ olderThanDays, limit }) => {
		const repository = makeRepository(pool);

		await expect(
			repository.deleteProcessedBefore({ olderThanDays, limit, statuses: ["PROCESSED"] }),
		).rejects.toThrow(/positive integer/);
		expect(pool.calls).toHaveLength(0);
	});
});

describe("OutboxRepository.requeueFailed", () => {
	let pool: MockPgPool;

	beforeEach(() => {
		pool = new MockPgPool();
	});

	it("moves FAILED records back to PENDING with a single DELETE ... RETURNING + INSERT ... SELECT statement", async () => {
		const repository = makeRepository(pool);
		pool.enqueueResult({ rows: [{ id: "a" }, { id: "b" }] });

		const requeued = await repository.requeueFailed(["a", "b", "c"]);

		expect(requeued).toEqual(["a", "b"]);
		expect(pool.calls).toHaveLength(1);
		expect(normalizeSql(pool.lastCall().text)).toBe(
			normalizeSql(`
				WITH moved AS (
					DELETE FROM "outbox" WHERE "id" = ANY($1) AND "status" = 'FAILED'
					RETURNING "id", "aggregate_id", "aggregate_type", "event_type", "payload", "sequence_number", "attempts", "created_at"
				)
				INSERT INTO "outbox" (
					"id", "aggregate_id", "aggregate_type", "event_type",
					"payload", "sequence_number", "status", "attempts",
					"created_at", "requeued_at", "processed_at"
				)
				SELECT moved."id", moved."aggregate_id", moved."aggregate_type", moved."event_type",
					moved."payload", moved."sequence_number", 'PENDING', moved."attempts",
					moved."created_at", NOW(), NULL
				FROM moved
				ORDER BY moved."created_at" ASC, moved."id" ASC
				RETURNING "id"
			`),
		);
		expect(pool.lastCall().params).toEqual([["a", "b", "c"]]);
	});

	it("uses the configured column naming and table name", async () => {
		const repository = makeRepository(pool, "PascalCase");
		pool.enqueueResult({ rows: [{ id: "a" }] });

		expect(await repository.requeueFailed(["a"])).toEqual(["a"]);

		const sql = normalizeSql(pool.lastCall().text);
		expect(sql).toContain(`DELETE FROM "Outbox" WHERE "id" = ANY($1) AND "status" = 'FAILED'`);
		expect(sql).toContain(`RETURNING "id", "AggregateId", "AggregateType", "EventType"`);
		expect(sql).toContain(`INSERT INTO "Outbox" (`);
		expect(sql).toContain(`"RequeuedAt", "ProcessedAt"`);
		expect(sql).toContain(`moved."CreatedAt", NOW(), NULL`);
		expect(sql).toContain(`ORDER BY moved."CreatedAt" ASC, moved."id" ASC RETURNING "id"`);
	});

	it("does not query for an empty id list", async () => {
		const repository = makeRepository(pool);

		expect(await repository.requeueFailed([])).toEqual([]);
		expect(pool.calls).toHaveLength(0);
	});
});

describe("OutboxRepository.markManyAsDead", () => {
	let pool: MockPgPool;

	beforeEach(() => {
		pool = new MockPgPool();
	});

	it("marks many records DEAD in one statement with a per-row optimistic lock on attempts", async () => {
		const repository = makeRepository(pool, "camelCase");
		pool.enqueueResult({ rows: [{ id: "a" }] });

		const marked = await repository.markManyAsDead([
			{ id: "a", attempts: 5 },
			{ id: "b", attempts: 7 },
		]);

		expect(marked).toEqual(["a"]);
		expect(pool.calls).toHaveLength(1);
		expect(normalizeSql(pool.lastCall().text)).toBe(
			normalizeSql(`
				UPDATE "outbox" AS t
				SET "status" = 'DEAD'
				FROM unnest($1::text[], $2::int[]) AS v(id, attempts)
				WHERE t."id" = ANY($3) AND t."id"::text = v.id AND t."attempts" = v.attempts
					AND t."status" IN ('PENDING', 'FAILED')
				RETURNING t."id"
			`),
		);
		expect(pool.lastCall().params).toEqual([
			["a", "b"],
			[5, 7],
			["a", "b"],
		]);
	});

	it("does not query for an empty list", async () => {
		const repository = makeRepository(pool);

		expect(await repository.markManyAsDead([])).toEqual([]);
		expect(pool.calls).toHaveLength(0);
	});
});
