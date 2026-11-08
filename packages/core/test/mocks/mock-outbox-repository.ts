import { type OutboxRecord, OutboxStatus } from "../../src/models/outbox-record";

export class MockOutboxRepository {
	private records: Map<string, OutboxRecord> = new Map();
	public findUnprocessedByIdCalls: string[] = [];
	public findUnprocessedByIdsCalls: string[][] = [];
	public markAsProcessedCalls: Array<{ id: string; sequenceNumber: number; attempts: number }> = [];
	public markAsFailedCalls: Array<{ id: string; attempts: number }> = [];
	public findStalePendingEventsCalls: Array<{ olderThanMinutes: number; limit: number }> = [];

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
	}): Promise<boolean> {
		this.markAsProcessedCalls.push({ id, sequenceNumber, attempts });
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.PROCESSED;
			record.sequenceNumber = sequenceNumber;
		}
		return true;
	}

	async markAsFailed({ id, attempts }: { id: string; attempts: number; retry?: unknown }): Promise<boolean> {
		this.markAsFailedCalls.push({ id, attempts });
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.FAILED;
			record.attempts = attempts + 1;
		}
		return true;
	}

	async markManyAsFailed(_params: { ids: string[] }): Promise<void> {
		throw new Error("Not implemented in mock");
	}

	async findFailedEvents(_limit = 100): Promise<OutboxRecord[]> {
		throw new Error("Not implemented in mock");
	}

	/**
	 * Simulates the DB query: PENDING records only, oldest first, capped at `limit`.
	 * Staleness is not simulated (every PENDING record added to the mock counts as stale).
	 */
	async findStalePendingEvents({
		olderThanMinutes,
		limit,
	}: {
		olderThanMinutes: number;
		limit: number;
	}): Promise<OutboxRecord[]> {
		this.findStalePendingEventsCalls.push({ olderThanMinutes, limit });
		return [...this.records.values()]
			.filter((record) => record.status === OutboxStatus.PENDING)
			.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
			.slice(0, limit);
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
		this.findStalePendingEventsCalls = [];
	}
}
