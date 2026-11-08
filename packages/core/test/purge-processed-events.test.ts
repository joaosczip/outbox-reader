import { beforeEach, describe, expect, it, mock } from "bun:test";
import { DEFAULT_BATCH_SIZE, type PurgeParams, run } from "../src/cronjobs/purge-processed-events";
import { OutboxStatus } from "../src/models/outbox-record";
import { MockLogger } from "./mocks/mock-logger";

type Row = { id: string; status: OutboxStatus; ageDays: number };
type DeleteArgs = { olderThanDays: number; limit: number; statuses: readonly string[] };

/** In-memory stand-in for the outbox table that applies the same retention rule as the SQL. */
class FakeOutboxTable {
	rows: Row[] = [];

	deleteProcessedBefore = mock(async ({ olderThanDays, limit, statuses }: DeleteArgs): Promise<number> => {
		const victims = this.rows
			.filter((row) => statuses.includes(row.status) && row.ageDays > olderThanDays)
			.slice(0, limit);
		this.rows = this.rows.filter((row) => !victims.includes(row));
		return victims.length;
	});

	add(count: number, status: OutboxStatus, ageDays: number): void {
		for (let i = 0; i < count; i++) this.rows.push({ id: `${status}-${ageDays}-${i}`, status, ageDays });
	}

	count(status: OutboxStatus): number {
		return this.rows.filter((row) => row.status === status).length;
	}

	calls(): DeleteArgs[] {
		return this.deleteProcessedBefore.mock.calls.map(([args]) => args);
	}
}

describe("purge-processed-events (retention)", () => {
	let table: FakeOutboxTable;
	let logger: MockLogger;

	const purge = (overrides: Partial<Omit<PurgeParams, "repository" | "logger">> = {}) =>
		run({ repository: table, logger, processedRetentionDays: 7, batchSize: 10, ...overrides });

	beforeEach(() => {
		table = new FakeOutboxTable();
		logger = new MockLogger();
	});

	it("does one query and returns an empty summary when nothing is old enough", async () => {
		table.add(5, OutboxStatus.PROCESSED, 3);

		const summary = await purge();

		expect(summary).toEqual({ processed: 0, dead: 0, batches: 1 });
		expect(table.calls()).toEqual([{ olderThanDays: 7, limit: 10, statuses: ["PROCESSED"] }]);
		expect(table.count(OutboxStatus.PROCESSED)).toBe(5);
	});

	it("loops in batches of batchSize and stops at the first short batch", async () => {
		table.add(25, OutboxStatus.PROCESSED, 30);

		const summary = await purge({ batchSize: 10 });

		// 10 + 10 + 5 (short batch => done)
		expect(table.calls()).toHaveLength(3);
		for (const call of table.calls())
			expect(call).toEqual({ olderThanDays: 7, limit: 10, statuses: ["PROCESSED"] });
		expect(summary).toEqual({ processed: 25, dead: 0, batches: 3 });
		expect(table.count(OutboxStatus.PROCESSED)).toBe(0);
	});

	it("issues one extra (empty) batch when the total is an exact multiple of batchSize", async () => {
		table.add(20, OutboxStatus.PROCESSED, 30);

		const summary = await purge({ batchSize: 10 });

		expect(table.deleteProcessedBefore.mock.results).toHaveLength(3);
		expect(summary).toEqual({ processed: 20, dead: 0, batches: 3 });
	});

	it("only deletes records older than the retention and keeps recent ones", async () => {
		table.add(4, OutboxStatus.PROCESSED, 30);
		table.add(3, OutboxStatus.PROCESSED, 2);

		const summary = await purge({ processedRetentionDays: 14 });

		expect(table.calls()[0].olderThanDays).toBe(14);
		expect(summary.processed).toBe(4);
		expect(table.count(OutboxStatus.PROCESSED)).toBe(3);
	});

	it("never touches DEAD, PENDING or FAILED records when DEAD retention is not configured", async () => {
		table.add(3, OutboxStatus.PROCESSED, 30);
		table.add(2, OutboxStatus.DEAD, 365);
		table.add(2, OutboxStatus.PENDING, 365);
		table.add(2, OutboxStatus.FAILED, 365);

		const summary = await purge();

		expect(table.calls().every((call) => call.statuses.length === 1 && call.statuses[0] === "PROCESSED")).toBe(
			true,
		);
		expect(summary).toEqual({ processed: 3, dead: 0, batches: 1 });
		expect(table.count(OutboxStatus.DEAD)).toBe(2);
		expect(table.count(OutboxStatus.PENDING)).toBe(2);
		expect(table.count(OutboxStatus.FAILED)).toBe(2);
	});

	it("purges DEAD records with their own retention when opted in", async () => {
		table.add(12, OutboxStatus.PROCESSED, 30);
		table.add(13, OutboxStatus.DEAD, 120);
		table.add(4, OutboxStatus.DEAD, 60);
		table.add(1, OutboxStatus.FAILED, 365);

		const summary = await purge({ processedRetentionDays: 7, deadRetentionDays: 90, batchSize: 10 });

		expect(table.calls()).toEqual([
			{ olderThanDays: 7, limit: 10, statuses: ["PROCESSED"] },
			{ olderThanDays: 7, limit: 10, statuses: ["PROCESSED"] },
			{ olderThanDays: 90, limit: 10, statuses: ["DEAD"] },
			{ olderThanDays: 90, limit: 10, statuses: ["DEAD"] },
		]);
		expect(summary).toEqual({ processed: 12, dead: 13, batches: 4 });
		expect(table.count(OutboxStatus.PROCESSED)).toBe(0);
		expect(table.count(OutboxStatus.DEAD)).toBe(4);
		expect(table.count(OutboxStatus.FAILED)).toBe(1);
	});

	it("uses the default batch size constant when none is given", async () => {
		await run({ repository: table, logger, processedRetentionDays: 7 });

		expect(table.calls()[0].limit).toBe(DEFAULT_BATCH_SIZE);
	});

	it("logs the final summary", async () => {
		table.add(3, OutboxStatus.PROCESSED, 30);

		await purge();

		const last = logger.logs.at(-1);
		expect(last?.level).toBe("info");
		expect(last?.extra).toMatchObject({ processed: 3, dead: 0, batches: 1 });
	});

	it("propagates a delete failure (so the job exits non-zero) after logging progress so far", async () => {
		table.add(15, OutboxStatus.PROCESSED, 30);
		const boom = new Error("db down");
		const original = table.deleteProcessedBefore.getMockImplementation();
		let calls = 0;
		table.deleteProcessedBefore.mockImplementation(async (args) => {
			if (++calls === 2) throw boom;
			return (original as NonNullable<typeof original>)(args);
		});

		await expect(purge({ batchSize: 10 })).rejects.toBe(boom);

		const errorLog = logger.logs.find((l) => l.level === "error");
		expect(errorLog?.error).toBe(boom);
		expect(errorLog?.extra).toMatchObject({ processed: 10, dead: 0, batches: 1 });
		expect(table.count(OutboxStatus.PROCESSED)).toBe(5);
	});

	it.each([0, -1, 1.5])("rejects an invalid batchSize %p without querying", async (batchSize) => {
		await expect(purge({ batchSize })).rejects.toThrow(/batchSize must be a positive integer/);
		expect(table.calls()).toHaveLength(0);
	});
});
