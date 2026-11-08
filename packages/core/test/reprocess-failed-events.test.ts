import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BATCH_SIZE, run } from "../src/cronjobs/reprocess-failed-events";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { OutboxRepository } from "../src/outbox-repository";
import type { RetryConfig } from "../src/types";
import { MockLogger } from "./mocks/mock-logger";
import { MockPgPool, normalizeSql } from "./mocks/mock-pg-pool";

const MAX_ATTEMPTS = 5;

const makeRow = (id: string, attempts = 1): OutboxRecord =>
	new OutboxRecord({
		id,
		aggregateId: `agg-${id}`,
		aggregateType: "User",
		eventType: "user.created",
		payload: { n: id },
		sequenceNumber: 1,
		status: OutboxStatus.FAILED,
		attempts,
	});

/**
 * Stateful in-memory repository: findFailedEvents only returns rows whose status is FAILED,
 * and the set-based writes behave like the real SQL (status + optimistic lock on attempts).
 */
const makeStatefulRepository = (rows: OutboxRecord[], { lockMissIds = new Set<string>() } = {}) => {
	const store = new Map(rows.map((r) => [r.id as string, new OutboxRecord({ ...r, createdAt: undefined })]));

	const repo = {
		findFailedEvents: mock(async (limit = 100) =>
			[...store.values()].filter((r) => r.status === OutboxStatus.FAILED).slice(0, limit),
		),
		onTransaction: mock(async (callback: (tx: OutboxRepository) => Promise<void>) => {
			await callback(repo as unknown as OutboxRepository);
		}),
		requeueFailed: mock(async (ids: string[]) =>
			ids.filter((id) => {
				const record = store.get(id);
				if (record?.status !== OutboxStatus.FAILED) return false;
				record.status = OutboxStatus.PENDING;
				return true;
			}),
		),
		markManyAsDead: mock(async (items: { id: string; attempts: number }[]) =>
			items
				.filter(({ id, attempts }) => {
					const record = store.get(id);
					return !lockMissIds.has(id) && record && record.attempts === attempts;
				})
				.map(({ id }) => {
					(store.get(id) as OutboxRecord).status = OutboxStatus.DEAD;
					return id;
				}),
		),
	};

	return { repo: repo as unknown as OutboxRepository & typeof repo, store };
};

describe("reprocess-failed-events", () => {
	let logger: MockLogger;

	beforeEach(() => {
		logger = new MockLogger();
	});

	describe("set-based SQL (one statement per kind of write, per batch)", () => {
		let pool: MockPgPool;
		let repository: OutboxRepository;

		const retryConfig: RetryConfig = { numOfAttempts: 1, startingDelayInMs: 1, maxDelayInMs: 1, jitter: "none" };
		const dbRow = (id: string, attempts: number) => ({
			id,
			aggregate_id: `agg-${id}`,
			aggregate_type: "User",
			event_type: "user.created",
			payload: { n: id },
			sequence_number: 1,
			created_at: new Date("2026-01-01T00:00:00.000Z"),
			processed_at: null,
			status: "FAILED",
			attempts,
		});

		beforeEach(() => {
			pool = new MockPgPool();
			repository = new OutboxRepository({ pool: pool.asPool(), retryConfig });
		});

		it("issues a constant number of queries per batch regardless of its size", async () => {
			const retryable = Array.from({ length: 50 }, (_, i) => dbRow(`r${i}`, 1));
			const exhausted = Array.from({ length: 20 }, (_, i) => dbRow(`d${i}`, MAX_ATTEMPTS + (i % 2)));
			pool.enqueueResult({ rows: [...retryable, ...exhausted] }); // findFailedEvents
			pool.enqueueResult({}); // BEGIN
			pool.enqueueResult({ rows: exhausted.slice(1).map(({ id }) => ({ id })) }); // markManyAsDead: d0 lock miss
			pool.enqueueResult({ rows: retryable.map(({ id }) => ({ id })) }); // requeueFailed
			pool.enqueueResult({}); // COMMIT
			pool.enqueueResult({ rows: [] }); // findFailedEvents (end)

			const summary = await run(repository, { maxAttempts: MAX_ATTEMPTS, logger });

			const texts = pool.calls.map((c) => normalizeSql(c.text));
			expect(texts).toHaveLength(6);
			expect(texts[0]).toStartWith("SELECT");
			expect(texts[1]).toBe("BEGIN");
			expect(texts[2]).toStartWith(`UPDATE "outbox" AS t SET "status" = 'DEAD'`);
			expect(texts[3]).toStartWith("WITH moved AS ( DELETE FROM");
			expect(texts[4]).toBe("COMMIT");
			expect(texts[5]).toStartWith("SELECT");
			expect(texts.filter((t) => t.startsWith("DELETE") || t.startsWith("INSERT"))).toHaveLength(0);

			expect(pool.calls[2].params).toEqual([
				exhausted.map((r) => r.id),
				exhausted.map((r) => r.attempts),
				exhausted.map((r) => r.id),
			]);
			expect(pool.calls[3].params).toEqual([retryable.map((r) => r.id)]);
			expect(summary).toEqual({ totalReprocessed: 50, totalDead: 19, lockMisses: 1, batches: 1 });
		});

		it("skips the statement for a kind of write the batch does not need", async () => {
			pool.enqueueResult({ rows: [dbRow("r1", 0)] });
			pool.enqueueResult({});
			pool.enqueueResult({ rows: [{ id: "r1" }] });
			pool.enqueueResult({});
			pool.enqueueResult({ rows: [] });

			await run(repository, { maxAttempts: MAX_ATTEMPTS, logger });

			const texts = pool.calls.map((c) => normalizeSql(c.text));
			expect(texts.map((t) => t.split(" ")[0])).toEqual(["SELECT", "BEGIN", "WITH", "COMMIT", "SELECT"]);
		});

		it("rolls back the whole batch when a set-based write fails", async () => {
			const rows = [dbRow("r1", 0), dbRow("d1", MAX_ATTEMPTS)];
			pool.query.mockImplementation(async (text: string, params?: unknown[]) => {
				pool.calls.push({ text, params });
				const sql = normalizeSql(text);
				if (sql.startsWith("SELECT")) return { rows, rowCount: rows.length };
				if (sql.startsWith("UPDATE")) return { rows: [{ id: "d1" }], rowCount: 1 };
				if (sql.startsWith("WITH")) throw new Error("db down");
				return { rows: [], rowCount: 0 };
			});

			await expect(run(repository, { maxAttempts: MAX_ATTEMPTS, logger })).rejects.toThrow("db down");

			const texts = pool.calls.map((c) => normalizeSql(c.text).split(" ")[0]);
			expect(texts).toEqual(["SELECT", "BEGIN", "UPDATE", "WITH", "ROLLBACK"]);
		});
	});

	describe("when there are no failed events", () => {
		it("does not open a transaction and reports nothing done", async () => {
			const { repo } = makeStatefulRepository([]);

			const summary = await run(repo, { maxAttempts: MAX_ATTEMPTS, logger });

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(1);
			expect(repo.onTransaction).not.toHaveBeenCalled();
			expect(summary).toEqual({ totalReprocessed: 0, totalDead: 0, lockMisses: 0, batches: 0 });
			expect(logger.logs.at(-1)?.message).toBe("No failed events to reprocess");
		});
	});

	describe("batching", () => {
		it("passes BATCH_SIZE as the limit and processes every batch in its own transaction", async () => {
			const rows = Array.from({ length: BATCH_SIZE + 30 }, (_, i) => makeRow(`r${i}`, 0));
			const { repo, store } = makeStatefulRepository(rows);

			const summary = await run(repo, { maxAttempts: MAX_ATTEMPTS, logger });

			expect(repo.findFailedEvents).toHaveBeenCalledWith(BATCH_SIZE);
			expect(repo.findFailedEvents).toHaveBeenCalledTimes(3);
			expect(repo.onTransaction).toHaveBeenCalledTimes(2);
			expect(repo.requeueFailed).toHaveBeenCalledTimes(2);
			expect(repo.requeueFailed.mock.calls[0][0]).toHaveLength(BATCH_SIZE);
			expect(repo.requeueFailed.mock.calls[1][0]).toHaveLength(30);
			expect([...store.values()].every((r) => r.status === OutboxStatus.PENDING)).toBe(true);
			expect(summary).toEqual({ totalReprocessed: BATCH_SIZE + 30, totalDead: 0, lockMisses: 0, batches: 2 });
		});
	});

	describe("max attempts (regression: endless delete/insert loop)", () => {
		it("marks FAILED records that reached maxAttempts as DEAD instead of re-inserting them", async () => {
			const rows = [makeRow("dead-1", MAX_ATTEMPTS), makeRow("dead-2", MAX_ATTEMPTS + 2), makeRow("retry-1", 4)];
			const { repo, store } = makeStatefulRepository(rows);

			const summary = await run(repo, { maxAttempts: MAX_ATTEMPTS, logger });

			expect(repo.markManyAsDead).toHaveBeenCalledTimes(1);
			expect(repo.markManyAsDead).toHaveBeenCalledWith([
				{ id: "dead-1", attempts: MAX_ATTEMPTS },
				{ id: "dead-2", attempts: MAX_ATTEMPTS + 2 },
			]);
			expect(repo.requeueFailed).toHaveBeenCalledTimes(1);
			expect(repo.requeueFailed).toHaveBeenCalledWith(["retry-1"]);
			expect(store.get("dead-1")?.status).toBe(OutboxStatus.DEAD);
			expect(store.get("dead-2")?.status).toBe(OutboxStatus.DEAD);
			expect(store.get("retry-1")?.status).toBe(OutboxStatus.PENDING);
			expect(summary).toEqual({ totalReprocessed: 1, totalDead: 2, lockMisses: 0, batches: 1 });

			const deadLogs = logger.logs.filter((l) => l.message.includes("marked as DEAD"));
			expect(deadLogs.map((l) => (l.extra as { id: string }).id)).toEqual(["dead-1", "dead-2"]);
		});

		it("terminates once every FAILED record is either DEAD or re-inserted as PENDING", async () => {
			const rows = [
				...Array.from({ length: BATCH_SIZE }, (_, i) => makeRow(`d${i}`, MAX_ATTEMPTS)),
				...Array.from({ length: 30 }, (_, i) => makeRow(`r${i}`, 0)),
			];
			const { repo, store } = makeStatefulRepository(rows);

			const summary = await run(repo, { maxAttempts: MAX_ATTEMPTS, logger });

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(3);
			expect(summary).toEqual({ totalReprocessed: 30, totalDead: BATCH_SIZE, lockMisses: 0, batches: 2 });
			expect([...store.values()].filter((r) => r.status === OutboxStatus.FAILED)).toHaveLength(0);
		});

		it("logs and counts optimistic-lock misses, and terminates although those records stay FAILED", async () => {
			const rows = [
				makeRow("stuck-1", MAX_ATTEMPTS),
				makeRow("ok-1", MAX_ATTEMPTS),
				makeRow("stuck-2", MAX_ATTEMPTS),
			];
			const { repo, store } = makeStatefulRepository(rows, { lockMissIds: new Set(["stuck-1", "stuck-2"]) });

			const summary = await run(repo, { maxAttempts: MAX_ATTEMPTS, logger });

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(2);
			expect(repo.markManyAsDead).toHaveBeenCalledTimes(1);
			expect(repo.requeueFailed).not.toHaveBeenCalled();
			expect(store.get("stuck-1")?.status).toBe(OutboxStatus.FAILED);
			expect(store.get("ok-1")?.status).toBe(OutboxStatus.DEAD);
			expect(summary).toEqual({ totalReprocessed: 0, totalDead: 1, lockMisses: 2, batches: 1 });

			const misses = logger.logs.filter((l) => l.level === "warn" && l.message.includes("optimistic-lock miss"));
			expect(misses.map((l) => (l.extra as { id: string }).id)).toEqual(["stuck-1", "stuck-2"]);
		});

		it("does not count records that were no longer FAILED when requeued", async () => {
			const rows = [makeRow("r1", 0), makeRow("r2", 0)];
			const { repo, store } = makeStatefulRepository(rows);
			repo.requeueFailed.mockImplementationOnce(async (ids: string[]) => {
				(store.get("r1") as OutboxRecord).status = OutboxStatus.PENDING;
				return ids.filter((id) => id === "r1");
			});

			const summary = await run(repo, { maxAttempts: MAX_ATTEMPTS, logger });

			expect(summary.totalReprocessed).toBe(1);
			const skipped = logger.logs.filter((l) => l.level === "warn" && l.message.includes("not requeued"));
			expect(skipped.map((l) => (l.extra as { id: string }).id)).toEqual(["r2"]);
		});
	});
});
