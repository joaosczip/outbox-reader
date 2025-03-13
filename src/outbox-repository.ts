import { Pool } from "pg";
import { backOff } from "exponential-backoff";
import { DateTime } from "luxon";

import { RetryCallback, RetryConfig } from "./types";
import { JitterType } from "exponential-backoff/dist/options";
import { OutboxRecord } from "./models/outbox-record";

type UpdateOutboxRecordParams = {
	id: string;
	sequenceNumber: number;
	attempts: number;
	retry: RetryCallback;
};

export class OutboxRepository {
	constructor(
		private pool: Pool,
		private retryConfig: RetryConfig,
	) {}

	async findUnprocessedById(id: string) {
		const query = `
			SELECT * FROM outbox
			WHERE id = $1 AND status IN ('PENDING', 'FAILED')
		`;
		const result = await this.pool.query(query, [id]);
		return result.rows[0] || null;
	}

	async findFailedEvents() {
		const query = `
			SELECT * FROM outbox
			WHERE status = 'FAILED'
		`;
		const result = await this.pool.query(query);
		return result.rows;
	}

	async findRecentPendingEvents(minutes = 10) {
		const query = `
			SELECT * FROM outbox
			WHERE created_at >= $1 AND status = 'PENDING'
			ORDER BY created_at ASC
		`;
		const minDate = DateTime.now().minus({ minutes }).toJSDate();
		const result = await this.pool.query(query, [minDate]);
		return result.rows;
	}

	async findLastProcessedEvent(): Promise<OutboxRecord | null> {
		const query = `
			SELECT * FROM outbox
			WHERE status = 'PROCESSED'
			ORDER BY sequence_number DESC
			LIMIT 1
		`;
		const result = await this.pool.query(query);
		const lastProcessedEvent = result.rows[0];

		return lastProcessedEvent
			? new OutboxRecord({
					...lastProcessedEvent,
					status: lastProcessedEvent.status,
					sequenceNumber: lastProcessedEvent.sequence_number,
					createdAt: lastProcessedEvent.created_at.toISOString(),
					processedAt: lastProcessedEvent.processed_at?.toISOString(),
				})
			: null;
	}

	async markAsProcessed({ id, sequenceNumber, attempts, retry }: UpdateOutboxRecordParams): Promise<void> {
		await backOff(
			async () => {
				const query = `
					UPDATE outbox 
					SET status = 'PROCESSED', 
						processed_at = NOW(), 
						attempts = attempts + 1, 
						sequence_number = $1
					WHERE id = $2 AND attempts = $3
				`;
				return this.pool.query(query, [sequenceNumber, id, attempts]);
			},
			{
				retry,
				startingDelay: this.retryConfig.startingDelayInMs,
				jitter: this.retryConfig.jitter as JitterType,
				maxDelay: this.retryConfig.maxDelayInMs,
				numOfAttempts: this.retryConfig.numOfAttempts,
			},
		);
	}

	async markAsFailed({ id, attempts, retry }: Omit<UpdateOutboxRecordParams, "sequenceNumber">): Promise<void> {
		await backOff(
			async () => {
				const query = `
					UPDATE outbox 
					SET status = 'FAILED', 
						attempts = attempts + 1
					WHERE id = $1 AND attempts = $2
				`;
				return this.pool.query(query, [id, attempts]);
			},
			{
				retry,
				startingDelay: this.retryConfig.startingDelayInMs,
				jitter: this.retryConfig.jitter as JitterType,
				maxDelay: this.retryConfig.maxDelayInMs,
				numOfAttempts: this.retryConfig.numOfAttempts,
			},
		);
	}
}
