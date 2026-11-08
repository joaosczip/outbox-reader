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
			ORDER BY ${c.createdAt} ASC, ${c.id} ASC
			LIMIT $1
		`;
		const result = await this.pool.query(query, [limit]);
		return result.rows.map((row: OutboxRow) => this.rowToRecord(row));
	}

	/**
	 * PENDING records created more than `olderThanMinutes` ago (oldest first), i.e. events
	 * the main service most likely lost (crash, lost in-memory retry, acked-but-unprocessed WAL).
	 * The cutoff is computed by the database clock to avoid app/DB clock skew.
	 *
	 * `created_at` stays the leading range predicate so the partial index
	 * `(created_at) WHERE status = 'PENDING'` can be used. A row requeued recently
	 * (old `created_at`, fresh `requeued_at`) is not stale; a never-requeued old PENDING row is.
	 * Do not replace the predicate with `COALESCE(requeued_at, created_at)`.
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
			WHERE ${c.status} = 'PENDING'
			  AND ${c.createdAt} < NOW() - make_interval(mins => $1::int)
			  AND (${c.requeuedAt} IS NULL OR ${c.requeuedAt} < NOW() - make_interval(mins => $1::int))
			ORDER BY ${c.createdAt} ASC, ${c.id} ASC
			LIMIT $2
		`;
		const result = await this.pool.query(query, [olderThanMinutes, limit]);
		return result.rows.map((row: OutboxRow) => this.rowToRecord(row));
	}

	/**
	 * True when an older sibling of the same aggregate is still PENDING or FAILED.
	 *
	 * DEAD is terminal and does not block: it is not part of either branch. The two
	 * `status = '...'` branches are unioned (not `status = ANY(...)` / `IN (...)`) so each
	 * can use its partial index on `(aggregate_id, created_at, id)`. The row comparison
	 * excludes the record itself. Order key is the immutable `(created_at, id)`.
	 */
	async hasOlderPendingOrFailed(record: OutboxRecord): Promise<boolean> {
		const c = this.qcols;
		const olderThan = `(${c.createdAt}, ${c.id}) < ($2::timestamp, $3::uuid)`;
		const query = `
			SELECT 1
			FROM (
				SELECT 1
				FROM ${this.tableName}
				WHERE ${c.status} = 'PENDING'
				  AND ${c.aggregateId} = $1
				  AND ${olderThan}
				UNION ALL
				SELECT 1
				FROM ${this.tableName}
				WHERE ${c.status} = 'FAILED'
				  AND ${c.aggregateId} = $1
				  AND ${olderThan}
			) AS older
			LIMIT 1
		`;
		const result = await this.pool.query(query, [record.aggregateId, record.createdAt, record.id]);
		return result.rows.length > 0;
	}

	/**
	 * Oldest PENDING row of the aggregate that has no older PENDING or FAILED sibling,
	 * or null when the oldest PENDING row is still blocked (or there is none).
	 */
	async findNextReadyPending(aggregateId: string): Promise<OutboxRecord | null> {
		const c = this.qcols;
		const query = `
			SELECT ${c.id}, ${c.aggregateId}, ${c.aggregateType}, ${c.eventType}, ${c.payload}, ${c.sequenceNumber},
			       ${c.createdAt}, ${c.processedAt}, ${c.status}, ${c.attempts}
			FROM ${this.tableName}
			WHERE ${c.status} = 'PENDING' AND ${c.aggregateId} = $1
			ORDER BY ${c.createdAt} ASC, ${c.id} ASC
			LIMIT 1
		`;
		const result = await this.pool.query(query, [aggregateId]);
		const row: OutboxRow | undefined = result.rows[0];
		if (!row) return null;
		const oldest = this.rowToRecord(row);
		if (await this.hasOlderPendingOrFailed(oldest)) return null;
		return oldest;
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

	/**
	 * Retention purge: deletes one bounded batch of terminal records (PROCESSED/DEAD only)
	 * older than `olderThanDays`, and returns how many rows this call deleted. Callers loop
	 * until a batch deletes fewer than `limit`. The cutoff is the database clock,
	 * `NOW() - make_interval(days => $1::int)`.
	 *
	 * A row is deleted only when all of these hold: status is PROCESSED or DEAD (never
	 * PENDING or FAILED), `created_at < cutoff`, and `COALESCE(processed_at, created_at) < cutoff`.
	 * Each statement embeds one status as a SQL literal so the planner can match a partial
	 * index. `status = ANY($1)` is not used. When `statuses` lists more than one, each status
	 * runs to completion with its own `limit` and the return value is the sum of the statements.
	 *
	 * PROCESSED uses two statements that share `limit`:
	 * 1. Hot path, written for partial index `idx_<table>_processed_processed_at` on
	 *    `(processed_at) WHERE status = 'PROCESSED'`: `processed_at IS NOT NULL AND
	 *    processed_at < cutoff AND created_at < cutoff`, ordered by `processed_at`.
	 * 2. Only when statement 1 deleted fewer than `limit` (remaining = `limit - deleted`).
	 *    Null `processed_at` keeps the COALESCE fallback (`status = 'PROCESSED' AND
	 *    processed_at IS NULL AND created_at < cutoff`), ordered by `created_at`. That case
	 *    is rare and has no dedicated index, so the statement may scan.
	 *
	 * DEAD is one statement, written for partial index `idx_<table>_dead_created_at` on
	 * `(created_at) WHERE status = 'DEAD'`: `created_at < cutoff AND
	 * COALESCE(processed_at, created_at) < cutoff`, ordered by `created_at`. `COALESCE` is a
	 * residual filter; the `created_at` range matches the partial index.
	 */
	async deleteProcessedBefore({
		olderThanDays,
		limit,
		statuses,
	}: {
		olderThanDays: number;
		limit: number;
		statuses: readonly string[];
	}): Promise<number> {
		const invalid = statuses.filter((s) => !PURGEABLE_STATUSES.includes(s));
		if (invalid.length) {
			throw new Error(
				`deleteProcessedBefore can purge only PROCESSED and DEAD records (got ${invalid.join(", ")})`,
			);
		}
		for (const [name, value] of [
			["olderThanDays", olderThanDays],
			["limit", limit],
		] as const) {
			if (!Number.isInteger(value) || value < 1) {
				throw new Error(`deleteProcessedBefore: ${name} must be a positive integer (got ${value})`);
			}
		}
		if (statuses.length === 0) return 0;

		let deleted = 0;
		for (const status of statuses) {
			deleted +=
				status === "PROCESSED"
					? await this.deleteProcessedBatch(olderThanDays, limit)
					: await this.deleteDeadBatch(olderThanDays, limit);
		}
		return deleted;
	}

	/** `NOW() - make_interval(days => $1::int)`. `$2` is the batch limit. */
	private purgeCutoffSql(): string {
		return "NOW() - make_interval(days => $1::int)";
	}

	private async deleteBySubquery(whereOrderLimit: string, olderThanDays: number, limit: number): Promise<number> {
		const c = this.qcols;
		const query = `
			DELETE FROM ${this.tableName}
			WHERE ${c.id} IN (
				SELECT ${c.id} FROM ${this.tableName}
				${whereOrderLimit}
			)
		`;
		const result = await this.pool.query(query, [olderThanDays, limit]);
		return result.rowCount ?? 0;
	}

	/**
	 * PROCESSED batch. Statement 1 is written for `idx_<table>_processed_processed_at`
	 * (`(processed_at) WHERE status = 'PROCESSED'`). Statement 2 runs only for a short batch
	 * and covers `processed_at IS NULL` (age falls back to `created_at`). It has no index of its
	 * own and may scan.
	 */
	private async deleteProcessedBatch(olderThanDays: number, limit: number): Promise<number> {
		const c = this.qcols;
		const cutoff = this.purgeCutoffSql();
		const deleted = await this.deleteBySubquery(
			`WHERE ${c.status} = 'PROCESSED'
				  AND ${c.processedAt} IS NOT NULL
				  AND ${c.processedAt} < ${cutoff}
				  AND ${c.createdAt} < ${cutoff}
				ORDER BY ${c.processedAt} ASC
				LIMIT $2`,
			olderThanDays,
			limit,
		);
		if (deleted >= limit) return deleted;

		const fallback = await this.deleteBySubquery(
			`WHERE ${c.status} = 'PROCESSED'
				  AND ${c.processedAt} IS NULL
				  AND ${c.createdAt} < ${cutoff}
				ORDER BY ${c.createdAt} ASC
				LIMIT $2`,
			olderThanDays,
			limit - deleted,
		);
		return deleted + fallback;
	}

	/**
	 * DEAD batch, written for `idx_<table>_dead_created_at`
	 * (`(created_at) WHERE status = 'DEAD'`). `COALESCE(processed_at, created_at) < cutoff`
	 * is a residual filter on top of the `created_at` range.
	 */
	private async deleteDeadBatch(olderThanDays: number, limit: number): Promise<number> {
		const c = this.qcols;
		const cutoff = this.purgeCutoffSql();
		return this.deleteBySubquery(
			`WHERE ${c.status} = 'DEAD'
				  AND ${c.createdAt} < ${cutoff}
				  AND COALESCE(${c.processedAt}, ${c.createdAt}) < ${cutoff}
				ORDER BY ${c.createdAt} ASC
				LIMIT $2`,
			olderThanDays,
			limit,
		);
	}

	/**
	 * Set-based requeue for the reprocess cron: in ONE statement, deletes the given records that
	 * are still FAILED and re-inserts them as PENDING (same id, attempts, payload, sequence number).
	 * `created_at` is copied from the deleted row — it is the immutable order key and must not be
	 * replaced with `NOW()`. `requeued_at = NOW()` records when the row was requeued (staleness
	 * only); `processed_at` is NULL. The re-INSERT produces the WAL event the replication service
	 * reacts to. Rows are inserted in `(created_at, id)` order. Returns the ids actually requeued
	 * (records that are no longer FAILED are skipped).
	 */
	async requeueFailed(ids: string[]): Promise<string[]> {
		if (ids.length === 0) return [];
		const c = this.qcols;
		const moved = [
			c.id,
			c.aggregateId,
			c.aggregateType,
			c.eventType,
			c.payload,
			c.sequenceNumber,
			c.attempts,
			c.createdAt,
		];
		const m = (col: string) => `moved.${col}`;
		const query = `
			WITH moved AS (
				DELETE FROM ${this.tableName} WHERE ${c.id} = ANY($1) AND ${c.status} = 'FAILED'
				RETURNING ${moved.join(", ")}
			)
			INSERT INTO ${this.tableName} (
				${c.id}, ${c.aggregateId}, ${c.aggregateType}, ${c.eventType},
				${c.payload}, ${c.sequenceNumber}, ${c.status}, ${c.attempts},
				${c.createdAt}, ${c.requeuedAt}, ${c.processedAt}
			)
			SELECT ${m(c.id)}, ${m(c.aggregateId)}, ${m(c.aggregateType)}, ${m(c.eventType)},
				${m(c.payload)}, ${m(c.sequenceNumber)}, 'PENDING', ${m(c.attempts)},
				${m(c.createdAt)}, NOW(), NULL
			FROM moved
			ORDER BY ${m(c.createdAt)} ASC, ${m(c.id)} ASC
			RETURNING ${c.id}
		`;
		const result = await this.pool.query(query, [ids]);
		return result.rows.map((row: OutboxRow) => String(row[this.cols.id]));
	}

	/**
	 * Set-based DEAD transition with a per-row optimistic lock on `attempts` (and PENDING/FAILED
	 * status). Returns the ids actually marked; any input id missing from the result was a lock
	 * miss. Ids are compared as text so it works for both UUID and text id columns, while
	 * `id = ANY($3)` (typed by the column) keeps the primary-key index usable.
	 */
	async markManyAsDead(records: { id: string; attempts: number }[]): Promise<string[]> {
		if (records.length === 0) return [];
		const c = this.qcols;
		const ids = records.map((r) => r.id);
		const query = `
			UPDATE ${this.tableName} AS t
			SET ${c.status} = 'DEAD'
			FROM unnest($1::text[], $2::int[]) AS v(id, attempts)
			WHERE t.${c.id} = ANY($3) AND t.${c.id}::text = v.id AND t.${c.attempts} = v.attempts
				AND t.${c.status} IN ('PENDING', 'FAILED')
			RETURNING t.${c.id}
		`;
		const result = await this.pool.query(query, [ids, records.map((r) => r.attempts), ids]);
		return result.rows.map((row: OutboxRow) => String(row[this.cols.id]));
	}
}

const PURGEABLE_STATUSES: readonly string[] = ["PROCESSED", "DEAD"];
