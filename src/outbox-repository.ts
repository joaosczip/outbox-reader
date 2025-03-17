import { Pool, PoolClient } from "pg";
import { backOff } from "exponential-backoff";
import { DateTime } from "luxon";
import { createId } from "@paralleldrive/cuid2";

import { RetryCallback, RetryConfig } from "./types";
import { JitterType } from "exponential-backoff/dist/options";
import { OutboxRecord } from "./models/outbox-record";

type UpdateOutboxRecordParams = {
	id: string;
	sequenceNumber: number;
	attempts: number;
	retry: RetryCallback;
};

type CreateOutboxRecordParams = {
	id?: string;
	aggregateId: string;
	aggregateType: string;
	eventType: string;
	payload: unknown;
	sequenceNumber: number;
	status: string;
	attempts?: number;
};

export class OutboxRepository {
	private pool: Pool;
	private retryConfig: RetryConfig;

	constructor({ pool, retryConfig }: { pool: Pool; retryConfig: RetryConfig }) {
		this.pool = pool;
		this.retryConfig = retryConfig;
	}

	async findUnprocessedById(id: string) {
		const query = `
			SELECT id, aggregate_id, aggregate_type, event_type, payload, sequence_number, 
			       created_at, processed_at, status, attempts 
			FROM outbox
			WHERE id = $1 AND status IN ('PENDING', 'FAILED')
		`;
		const result = await this.pool.query(query, [id]);
		return result.rows[0] || null;
	}

	async findFailedEvents() {
		const query = `
			SELECT id, aggregate_id, aggregate_type, event_type, payload, sequence_number, 
			       created_at, processed_at, status, attempts 
			FROM outbox
			WHERE status = 'FAILED'
		`;
		const result = await this.pool.query(query);
		return result.rows;
	}

	async findRecentPendingEvents(minutes = 10) {
		const query = `
			SELECT id, aggregate_id, aggregate_type, event_type, payload, sequence_number, 
			       created_at, processed_at, status, attempts 
			FROM outbox
			WHERE created_at >= $1 AND status = 'PENDING'
			ORDER BY created_at ASC
		`;
		const minDate = DateTime.now().minus({ minutes }).toJSDate();
		const result = await this.pool.query(query, [minDate]);
		return result.rows;
	}

	async findLastProcessedEvent(): Promise<OutboxRecord | null> {
		const query = `
			SELECT id, aggregate_id, aggregate_type, event_type, payload, sequence_number, 
			       created_at, processed_at, status, attempts 
			FROM outbox
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

	async create(params: CreateOutboxRecordParams): Promise<string> {
		const {
			id = createId(),
			aggregateId,
			aggregateType,
			eventType,
			payload,
			sequenceNumber,
			status,
			attempts = 0,
		} = params;

		const query = `
			INSERT INTO outbox (
				id, aggregate_id, aggregate_type, event_type, 
				payload, sequence_number, status, attempts, 
				created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
			RETURNING id
		`;

		const values = [id, aggregateId, aggregateType, eventType, payload, sequenceNumber, status, attempts];
		const result = await this.pool.query(query, values);

		return result.rows[0].id;
	}

	async delete(id: string, status: string): Promise<void> {
		const query = `DELETE FROM outbox WHERE id = $1 AND status = $2`;
		await this.pool.query(query, [id, status]);
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

	async markManyAsFailed({ ids }: { ids: string[] }): Promise<void> {
		const query = `
			UPDATE outbox 
			SET status = 'FAILED', 
				attempts = attempts + 1
			WHERE id = $1
		`;

		await Promise.all(
			ids.map(async (id) => {
				await this.pool.query(query, [id]);
			}),
		);
	}

	async onTransaction(callback: (tx: OutboxRepository) => Promise<void>) {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const transaction = new Proxy(this, {
				get(target, prop) {
					if (prop === "pool") {
						return client;
					}

					return Reflect.get(target, prop);
				},
			});

			await callback(transaction);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}
