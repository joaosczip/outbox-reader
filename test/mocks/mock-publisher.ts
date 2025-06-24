import { OutboxRecord } from "../../src/models/outbox-record";
import { Publisher, RetryCallback } from "../../src/types";

export class MockPublisher implements Publisher {
	public retryConfig = {
		jitter: "full" as const,
		maxDelayInMs: 5000,
		numOfAttempts: 3,
		startingDelayInMs: 100,
	};

	public publishedRecords: OutboxRecord[] = [];
	public publishCalls: Array<{ record: OutboxRecord; retry: RetryCallback }> = [];
	public shouldFail = false;
	public publishedSequenceNumber = 12345;
	public errorToThrow: Error | null = null;

	async publish({ record, retry }: { record: OutboxRecord; retry: RetryCallback }): Promise<number> {
		this.publishCalls.push({ record, retry });

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
	}

	setSequenceNumber(seq: number): void {
		this.publishedSequenceNumber = seq;
	}

	setError(error: Error): void {
		this.errorToThrow = error;
		this.shouldFail = true;
	}
}
