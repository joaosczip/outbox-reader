import type { OutboxRecord } from "../../src/models/outbox-record";
import type { Publisher } from "../../src/types";

export class MockPublisher implements Publisher {
	public retryConfig = {
		jitter: "full" as const,
		maxDelayInMs: 5000,
		numOfAttempts: 3,
		startingDelayInMs: 100,
	};

	public publishedRecords: OutboxRecord[] = [];
	public publishCalls: Array<{ record: OutboxRecord }> = [];
	public shouldFail = false;
	public publishedSequenceNumber = 12345;
	public errorToThrow: Error | null = null;
	public connectCalls = 0;
	public closeCalls = 0;

	async connect(): Promise<void> {
		this.connectCalls++;
	}

	async close(): Promise<void> {
		this.closeCalls++;
	}

	async publish({ record }: { record: OutboxRecord }): Promise<number> {
		this.publishCalls.push({ record });

		if (this.shouldFail) {
			const error = this.errorToThrow || new Error("Publisher failed");
			throw error;
		}

		this.publishedRecords.push(record);
		return this.publishedSequenceNumber;
	}

	// Test helper methods
	reset(): void {
		this.publishedRecords = [];
		this.publishCalls = [];
		this.shouldFail = false;
		this.publishedSequenceNumber = 12345;
		this.errorToThrow = null;
		this.connectCalls = 0;
		this.closeCalls = 0;
	}

	setSequenceNumber(seq: number): void {
		this.publishedSequenceNumber = seq;
	}

	setError(error: Error): void {
		this.errorToThrow = error;
		this.shouldFail = true;
	}
}
