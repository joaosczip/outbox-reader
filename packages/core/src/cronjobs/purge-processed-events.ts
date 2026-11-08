/**
 * Retention purge for terminal outbox records.
 *
 * PROCESSED (and, opt-in, DEAD) records are never needed again by the replication flow, but
 * without a purge the outbox table and its indexes grow without bound, slowing every query,
 * status update and vacuum. This job deletes them in bounded batches (each batch is its own
 * short statement/transaction, so locks and WAL bursts stay small) until a batch comes back
 * short.
 *
 * - PROCESSED: deleted once `processed_at` is older than PROCESSED_RETENTION_DAYS (default 7).
 * - DEAD: kept forever by default, because DEAD records exhausted their attempts and need a
 *   human to inspect them. Set DEAD_RETENTION_DAYS to purge them as well; their age is
 *   `COALESCE(processed_at, created_at)` since DEAD records normally have no `processed_at`.
 * - PENDING/FAILED are never touched (the repository refuses those statuses).
 *
 * Deleting rows does not emit outbox INSERTs, so the WAL replication flow ignores it.
 */
import type { Logger } from "../logger";
import { OutboxStatus } from "../models/outbox-record";
import type { OutboxRepository } from "../outbox-repository";

export const DEFAULT_BATCH_SIZE = 1000;

export type PurgeSummary = { processed: number; dead: number; batches: number };

export type PurgeParams = {
	repository: Pick<OutboxRepository, "deleteProcessedBefore">;
	logger: Pick<Logger, "info" | "error">;
	processedRetentionDays: number;
	/** Undefined disables purging of DEAD records. */
	deadRetentionDays?: number;
	batchSize?: number;
};

export const run = async ({
	repository,
	logger,
	processedRetentionDays,
	deadRetentionDays,
	batchSize = DEFAULT_BATCH_SIZE,
}: PurgeParams): Promise<PurgeSummary> => {
	if (!Number.isInteger(batchSize) || batchSize < 1) {
		throw new Error(`purge-processed-events: batchSize must be a positive integer (got ${batchSize})`);
	}

	const summary: PurgeSummary = { processed: 0, dead: 0, batches: 0 };
	const targets: Array<{ key: "processed" | "dead"; status: OutboxStatus; olderThanDays: number }> = [
		{ key: "processed", status: OutboxStatus.PROCESSED, olderThanDays: processedRetentionDays },
	];
	if (deadRetentionDays !== undefined) {
		targets.push({ key: "dead", status: OutboxStatus.DEAD, olderThanDays: deadRetentionDays });
	}

	logger.info({
		message: "Purging terminal outbox records",
		extra: { processedRetentionDays, deadRetentionDays: deadRetentionDays ?? "disabled", batchSize },
	});

	try {
		for (const { key, status, olderThanDays } of targets) {
			while (true) {
				const deleted = await repository.deleteProcessedBefore({
					olderThanDays,
					limit: batchSize,
					statuses: [status],
				});
				summary.batches++;
				summary[key] += deleted;
				// A short batch means nothing older than the cutoff was left when it ran.
				if (deleted < batchSize) break;
			}
		}
	} catch (error) {
		logger.error({ message: "Failed to purge terminal outbox records", error, extra: { ...summary } });
		throw error;
	}

	logger.info({ message: "Finished purging terminal outbox records", extra: { ...summary } });
	return summary;
};

if (import.meta.main) {
	const { Pool } = await import("pg");
	const { loadCronConfig } = await import("../config");
	const { Logger } = await import("../logger");
	const { OutboxRepository } = await import("../outbox-repository");

	const logger = new Logger("outbox-reader:purge-processed-events");
	let pool: InstanceType<typeof Pool> | undefined;
	let exitCode = 0;

	try {
		const cfg = loadCronConfig();
		pool = new Pool({ connectionString: cfg.connectionString });

		const repository = new OutboxRepository({
			pool,
			retryConfig: cfg.cronRetryConfig,
			columnNaming: cfg.columnNaming,
			tableName: cfg.tableName,
		});

		await run({
			repository,
			logger,
			processedRetentionDays: cfg.processedRetentionDays,
			deadRetentionDays: cfg.deadRetentionDays,
		});
	} catch (error) {
		logger.error({ message: "Outbox retention purge failed", error });
		exitCode = 1;
	} finally {
		await pool?.end().catch((error) => logger.error({ message: "Error closing DB pool", error }));
	}

	process.exit(exitCode);
}
