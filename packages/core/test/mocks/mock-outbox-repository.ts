import { type OutboxRecord, OutboxStatus } from "../../src/models/outbox-record";

export class MockOutboxRepository {
	private records: Map<string, OutboxRecord> = new Map();
	public findUnprocessedByIdCalls: string[] = [];
	public markAsProcessedCalls: Array<{ id: string; sequenceNumber: number; attempts: number }> = [];
	public markAsFailedCalls: Array<{ id: string; attempts: number }> = [];

	async findUnprocessedById(id: string): Promise<OutboxRecord | null> {
		this.findUnprocessedByIdCalls.push(id);
		return this.records.get(id) || null;
	}

	async markAsProcessed({
		id,
		sequenceNumber,
		attempts,
	}: {
		id: string;
		sequenceNumber: number;
		attempts: number;
	}): Promise<void> {
		this.markAsProcessedCalls.push({ id, sequenceNumber, attempts });
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.PROCESSED;
			record.sequenceNumber = sequenceNumber;
		}
	}

	async markAsFailed({ id, attempts }: { id: string; attempts: number }): Promise<void> {
		this.markAsFailedCalls.push({ id, attempts });
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.FAILED;
			record.attempts = attempts + 1;
		}
	}

	// Test helper methods
	addRecord(record: OutboxRecord): void {
		this.records.set(record.id!, record);
	}

	getRecord(id: string): OutboxRecord | undefined {
		return this.records.get(id);
	}

	reset(): void {
		this.records.clear();
		this.findUnprocessedByIdCalls = [];
		this.markAsProcessedCalls = [];
		this.markAsFailedCalls = [];
	}
}
