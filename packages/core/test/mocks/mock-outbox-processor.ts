import type { Wal2Json } from "pg-logical-replication";
import type { OutboxRecord } from "../../src/models/outbox-record";
import type { Publisher } from "../../src/types";

type ProcessInsertsParams = {
	insertedRecord: OutboxRecord;
	publisher: Publisher;
	prefetchedOutbox?: OutboxRecord | null;
};

export class MockOutboxProcessor {
	public processInsertsCalls: ProcessInsertsParams[] = [];
	private behavior: ((params: ProcessInsertsParams) => void | Promise<void>) | null = null;
	private error: Error | null = null;

	setShouldSucceed(): void {
		this.error = null;
		this.behavior = null;
	}

	setError(e: Error): void {
		this.error = e;
		this.behavior = null;
	}

	setCustomBehavior(fn: (params: ProcessInsertsParams) => void | Promise<void>): void {
		this.behavior = fn;
		this.error = null;
	}

	async processInserts(params: ProcessInsertsParams): Promise<void> {
		this.processInsertsCalls.push(params);
		if (this.behavior) {
			await this.behavior(params);
			return;
		}
		if (this.error) throw this.error;
	}

	filterChanges(_log: Wal2Json.Output): OutboxRecord[] {
		throw new Error("Not implemented in mock");
	}

	reset(): void {
		this.processInsertsCalls = [];
		this.error = null;
		this.behavior = null;
	}
}
