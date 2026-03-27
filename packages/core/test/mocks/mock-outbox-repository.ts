import { type OutboxRecord, OutboxStatus } from "../../src/models/outbox-record";
import type { OutboxRow } from "../../src/outbox-repository";

export class MockOutboxRepository {
	private records: Map<string, OutboxRecord> = new Map();
	public findUnprocessedByIdCalls: string[] = [];
	public findUnprocessedByIdsCalls: string[][] = [];
	public markAsProcessedCalls: Array<{ id: string; sequenceNumber: number; attempts: number }> = [];
	public markAsFailedCalls: Array<{ id: string; attempts: number }> = [];

	async findUnprocessedById(id: string): Promise<OutboxRecord | null> {
		this.findUnprocessedByIdCalls.push(id);
		return this.records.get(id) || null;
	}

	async findUnprocessedByIds(ids: string[]): Promise<OutboxRecord[]> {
		this.findUnprocessedByIdsCalls.push(ids);
		return ids.flatMap((id) => {
			const record = this.records.get(id);
			return record ? [record] : [];
		});
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

	async markAsFailed({ id, attempts }: { id: string; attempts: number; retry?: unknown }): Promise<void> {
		this.markAsFailedCalls.push({ id, attempts });
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.FAILED;
			record.attempts = attempts + 1;
		}
	}

	async markManyAsFailed(_params: { ids: string[] }): Promise<void> {
		throw new Error("Not implemented in mock");
	}

	async findFailedEvents(): Promise<OutboxRow[]> {
		throw new Error("Not implemented in mock");
	}

	async findRecentPendingEvents(_minutes?: number): Promise<OutboxRow[]> {
		throw new Error("Not implemented in mock");
	}

	async findLastProcessedEvent(): Promise<OutboxRecord | null> {
		throw new Error("Not implemented in mock");
	}

	async create(_params: {
		id?: string;
		aggregateId: string;
		aggregateType: string;
		eventType: string;
		payload: unknown;
		sequenceNumber: number;
		status: string;
		attempts?: number;
	}): Promise<string> {
		throw new Error("Not implemented in mock");
	}

	async delete(_id: string, _status: string): Promise<void> {
		throw new Error("Not implemented in mock");
	}

	async onTransaction(_callback: (tx: MockOutboxRepository) => Promise<void>): Promise<void> {
		throw new Error("Not implemented in mock");
	}

	// Test helper methods
	addRecord(record: OutboxRecord): void {
		this.records.set(record.id ?? "", record);
	}

	getRecord(id: string): OutboxRecord | undefined {
		return this.records.get(id);
	}

	reset(): void {
		this.records.clear();
		this.findUnprocessedByIdCalls = [];
		this.findUnprocessedByIdsCalls = [];
		this.markAsProcessedCalls = [];
		this.markAsFailedCalls = [];
	}
}
