import { type OutboxRecord, OutboxStatus } from "../../src/models/outbox-record";

export class MockOutboxRepository {
	private records: Map<string, OutboxRecord> = new Map();
	public findUnprocessedByIdCalls: string[] = [];
	public findUnprocessedByIdsCalls: string[][] = [];
	public markAsProcessedCalls: Array<{ id: string; sequenceNumber: number; attempts: number }> = [];
	public markAsFailedCalls: Array<{ id: string; attempts: number }> = [];
	public findStalePendingEventsCalls: Array<{ olderThanMinutes: number; limit: number }> = [];
	public markAsDeadCalls: Array<{ id: string; attempts: number; countAttempt?: boolean }> = [];
	public hasOlderPendingOrFailedCalls: OutboxRecord[] = [];
	public findNextReadyPendingCalls: string[] = [];
	/** Return values of the optimistic-lock writes; set to false to simulate a lock miss. */
	public markAsProcessedResult = true;
	public markAsFailedResult = true;
	public markAsDeadResult = true;
	/**
	 * When false (the default), `hasOlderPendingOrFailed` returns false and `findNextReadyPending`
	 * returns null so tests that do not care about aggregate order stay unchanged.
	 * When true, both use the in-memory records and `(createdAt, id)` order. DEAD does not block.
	 */
	public enforceAggregateOrder = false;
	/** Used when `enforceAggregateOrder` is false. */
	public hasOlderPendingOrFailedResult = false;

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
		if (!this.markAsProcessedResult) return false;
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.PROCESSED;
			record.sequenceNumber = sequenceNumber;
		}
		return true;
	}

	async markAsFailed({ id, attempts }: { id: string; attempts: number; retry?: unknown }): Promise<boolean> {
		this.markAsFailedCalls.push({ id, attempts });
		if (!this.markAsFailedResult) return false;
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.FAILED;
			record.attempts = attempts + 1;
		}
		return true;
	}

	async markAsDead({
		id,
		attempts,
		countAttempt,
	}: {
		id: string;
		attempts: number;
		retry?: unknown;
		countAttempt?: boolean;
	}): Promise<boolean> {
		this.markAsDeadCalls.push(countAttempt === undefined ? { id, attempts } : { id, attempts, countAttempt });
		if (!this.markAsDeadResult) return false;
		const record = this.records.get(id);
		if (record) {
			record.status = OutboxStatus.DEAD;
			if (countAttempt) record.attempts = attempts + 1;
		}
		return true;
	}

	async hasOlderPendingOrFailed(record: OutboxRecord): Promise<boolean> {
		this.hasOlderPendingOrFailedCalls.push(record);
		if (!this.enforceAggregateOrder) return this.hasOlderPendingOrFailedResult;
		return this.isOlderBlocking(record);
	}

	async findNextReadyPending(aggregateId: string): Promise<OutboxRecord | null> {
		this.findNextReadyPendingCalls.push(aggregateId);
		if (!this.enforceAggregateOrder) return null;
		const pending = [...this.records.values()]
			.filter((record) => record.aggregateId === aggregateId && record.status === OutboxStatus.PENDING)
			.sort((a, b) => compareOrder(a, b));
		const oldest = pending[0];
		if (!oldest || this.isOlderBlocking(oldest)) return null;
		return oldest;
	}

	private isOlderBlocking(candidate: OutboxRecord): boolean {
		for (const other of this.records.values()) {
			if (other.id === candidate.id) continue;
			if (other.aggregateId !== candidate.aggregateId) continue;
			if (other.status !== OutboxStatus.PENDING && other.status !== OutboxStatus.FAILED) continue;
			if (compareOrder(other, candidate) < 0) return true;
		}
		return false;
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
		this.markAsDeadCalls = [];
		this.markAsProcessedResult = true;
		this.markAsFailedResult = true;
		this.markAsDeadResult = true;
		this.hasOlderPendingOrFailedCalls = [];
		this.findNextReadyPendingCalls = [];
		this.enforceAggregateOrder = false;
		this.hasOlderPendingOrFailedResult = false;
	}
}

const compareOrder = (a: OutboxRecord, b: OutboxRecord): number => {
	const delta = (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
	if (delta !== 0) return delta;
	return (a.id ?? "").localeCompare(b.id ?? "");
};
