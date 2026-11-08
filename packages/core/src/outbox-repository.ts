import { createId } from "@paralleldrive/cuid2";
import { backOff } from "exponential-backoff";
import type { Pool } from "pg";

import type { JitterType } from "exponential-backoff/dist/options";
import { OutboxRecord } from "./models/outbox-record";
import type { RetryCallback, RetryConfig } from "./types";
import {
	type ColumnNaming,
	type OutboxColumnNames,
	applyNamingToTableName,
	getColumnNames,
} from "./utils/column-naming";

export type OutboxRow = Record<string, unknown>;

/**
 * Quotes a PostgreSQL identifier (table/column name) so its case is preserved
 * (unquoted identifiers are folded to lowercase). Embedded double quotes are escaped.
 */
export const quoteIdent = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

const quoteColumnNames = (cols: OutboxColumnNames): OutboxColumnNames =>
	Object.fromEntries(
		Object.entries(cols).map(([key, name]) => [key, quoteIdent(name)]),
	) as unknown as OutboxColumnNames;

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
	/** Raw column names, used as keys of the rows returned by pg. */
	private cols: OutboxColumnNames;
	/** Quoted column names, used when building SQL. */
	private qcols: OutboxColumnNames;
	/** Quoted table name, used when building SQL. */
	private tableName: string;

	constructor({
		pool,
		retryConfig,
		columnNaming = "snake_case",
		tableName = "outbox",
	}: {
		pool: Pool;
		retryConfig: RetryConfig;
		columnNaming?: ColumnNaming;
		tableName?: string;
	}) {
		this.pool = pool;
		this.retryConfig = retryConfig;
		this.cols = getColumnNames(columnNaming);
		this.qcols = quoteColumnNames(this.cols);
		this.tableName = quoteIdent(applyNamingToTableName(tableName, columnNaming));
	}

	async findUnprocessedById(id: string): Promise<OutboxRecord | null> {
		const c = this.qcols;
		const query = `
			SELECT ${c.id}, ${c.aggregateId}, ${c.aggregateType}, ${c.eventType}, ${c.payload}, ${c.sequenceNumber},
			       ${c.createdAt}, ${c.processedAt}, ${c.status}, ${c.attempts}
			FROM ${this.tableName}
			WHERE ${c.id} = $1 AND ${c.status} IN ('PENDING', 'FAILED')
		`;
		const result = await this.pool.query(query, [id]);
		const row: OutboxRow | undefined = result.rows[0];
		return row ? this.rowToRecord(row) : null;
	}

	async findUnprocessedByIds(ids: string[]): Promise<OutboxRecord[]> {
		if (ids.length === 0) return [];
		const c = this.qcols;
		const query = `
			SELECT ${c.id}, ${c.aggregateId}, ${c.aggregateType}, ${c.eventType}, ${c.payload}, ${c.sequenceNumber},
			       ${c.createdAt}, ${c.processedAt}, ${c.status}, ${c.attempts}
			FROM ${this.tableName}
			WHERE ${c.id} = ANY($1) AND ${c.status} IN ('PENDING', 'FAILED')
		`;
		const result = await this.pool.query(query, [ids]);
		return result.rows.map((row: OutboxRow) => this.rowToRecord(row));
	}

	private rowToRecord(row: OutboxRow): OutboxRecord {
		const c = this.cols;
		const createdAt = row[c.createdAt] as Date;
		const processedAt = row[c.processedAt] as Date | null;
		return new OutboxRecord({
			id: row[c.id] as string,
			aggregateId: row[c.aggregateId] as string,
			aggregateType: row[c.aggregateType] as string,
			eventType: row[c.eventType] as string,
			payload: row[c.payload],
			sequenceNumber: row[c.sequenceNumber] as number,
			createdAt: createdAt?.toISOString(),
			processedAt: processedAt?.toISOString(),
			status: row[c.status] as OutboxRecord["status"],
			attempts: row[c.attempts] as number,
		});
	}

	async findFailedEvents(limit = 100): Promise<OutboxRecord[]> {
		const c = this.qcols;
		const query = `
			SELECT ${c.id}, ${c.aggregateId}, ${c.aggregateType}, ${c.eventType}, ${c.payload}, ${c.sequenceNumber},
			       ${c.createdAt}, ${c.processedAt}, ${c.status}, ${c.attempts}
			FROM ${this.tableName}
			WHERE ${c.status} = 'FAILED'
			ORDER BY ${c.createdAt} ASC
			LIMIT $1
		`;
		const result = await this.pool.query(query, [limit]);
		return result.rows.map((row: OutboxRow) => this.rowToRecord(row));
	}

	/**
	 * PENDING records created more than `olderThanMinutes` ago (oldest first), i.e. events
	 * the main service most likely lost (crash, lost in-memory retry, acked-but-unprocessed WAL).
	 * The cutoff is computed by the database clock to avoid app/DB clock skew.
	 */
	async findStalePendingEvents({
		olderThanMinutes,
		limit,
	}: {
		olderThanMinutes: number;
		limit: number;
	}): Promise<OutboxRecord[]> {
		const c = this.qcols;
		const query = `
			SELECT ${c.id}, ${c.aggregateId}, ${c.aggregateType}, ${c.eventType}, ${c.payload}, ${c.sequenceNumber},
			       ${c.createdAt}, ${c.processedAt}, ${c.status}, ${c.attempts}
			FROM ${this.tableName}
			WHERE ${c.status} = 'PENDING' AND ${c.createdAt} < NOW() - make_interval(mins => $1::int)
			ORDER BY ${c.createdAt} ASC
			LIMIT $2
		`;
		const result = await this.pool.query(query, [olderThanMinutes, limit]);
		return result.rows.map((row: OutboxRow) => this.rowToRecord(row));
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

		const c = this.qcols;
		const query = `
			INSERT INTO ${this.tableName} (
				${c.id}, ${c.aggregateId}, ${c.aggregateType}, ${c.eventType},
				${c.payload}, ${c.sequenceNumber}, ${c.status}, ${c.attempts},
				${c.createdAt}
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
			RETURNING ${c.id}
		`;

		const values = [id, aggregateId, aggregateType, eventType, payload, sequenceNumber, status, attempts];
		const result = await this.pool.query(query, values);

		return result.rows[0][this.cols.id] as string;
	}

	async delete(id: string, status: string): Promise<void> {
		const c = this.qcols;
		const query = `DELETE FROM ${this.tableName} WHERE ${c.id} = $1 AND ${c.status} = $2`;
		await this.pool.query(query, [id, status]);
	}

	async markAsProcessed({ id, sequenceNumber, attempts, retry }: UpdateOutboxRecordParams): Promise<boolean> {
		const c = this.qcols;
		const result = await backOff(
			async () => {
				const query = `
					UPDATE ${this.tableName}
					SET ${c.status} = 'PROCESSED',
						${c.processedAt} = NOW(),
						${c.attempts} = ${c.attempts} + 1,
						${c.sequenceNumber} = $1
					WHERE ${c.id} = $2 AND ${c.attempts} = $3
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
		return (result.rowCount ?? 0) > 0;
	}

	async markAsFailed({ id, attempts, retry }: Omit<UpdateOutboxRecordParams, "sequenceNumber">): Promise<boolean> {
		const c = this.qcols;
		const result = await backOff(
			async () => {
				const query = `
					UPDATE ${this.tableName}
					SET ${c.status} = 'FAILED',
						${c.attempts} = ${c.attempts} + 1
					WHERE ${c.id} = $1 AND ${c.attempts} = $2
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
		return (result.rowCount ?? 0) > 0;
	}

	/**
	 * Moves a PENDING/FAILED record to the terminal DEAD status (optimistic lock on `attempts`).
	 * `countAttempt` increments `attempts` when the DEAD transition follows a real (failed)
	 * publish attempt; leave it false when the record is retired without a new attempt.
	 * Returns false when no row matched (record changed concurrently).
	 */
	async markAsDead({
		id,
		attempts,
		retry,
		countAttempt = false,
	}: Omit<UpdateOutboxRecordParams, "sequenceNumber"> & { countAttempt?: boolean }): Promise<boolean> {
		const c = this.qcols;
		const result = await backOff(
			async () => {
				const query = `
					UPDATE ${this.tableName}
					SET ${c.status} = 'DEAD',
						${c.attempts} = ${c.attempts} + $3
					WHERE ${c.id} = $1 AND ${c.attempts} = $2 AND ${c.status} IN ('PENDING', 'FAILED')
				`;
				return this.pool.query(query, [id, attempts, countAttempt ? 1 : 0]);
			},
			{
				retry,
				startingDelay: this.retryConfig.startingDelayInMs,
				jitter: this.retryConfig.jitter as JitterType,
				maxDelay: this.retryConfig.maxDelayInMs,
				numOfAttempts: this.retryConfig.numOfAttempts,
			},
		);
		return (result.rowCount ?? 0) > 0;
	}

	async markManyAsFailed({ ids }: { ids: string[] }): Promise<void> {
		if (ids.length === 0) return;
		const c = this.qcols;
		const query = `
			UPDATE ${this.tableName}
			SET ${c.status} = 'FAILED',
				${c.attempts} = ${c.attempts} + 1
			WHERE ${c.id} = ANY($1)
		`;

		await this.pool.query(query, [ids]);
	}

	async onTransaction(callback: (tx: OutboxRepository) => Promise<void>): Promise<void> {
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
