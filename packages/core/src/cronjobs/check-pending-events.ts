/**
 * Stale PENDING sweeper.
 *
 * Finds PENDING outbox records older than a threshold (events the main service most likely
 * lost: process crash, in-memory RetryQueue lost, WAL event acked but never processed) and
 * pushes each one through the regular OutboxProcessor flow with the configured publisher.
 * A record that fails is marked FAILED, so it enters the FAILED → reprocess-failed-events flow.
 *
 * Delivery is at-least-once: NATS dedups by record id only within the stream's duplicate
 * window (default 2 minutes). If the original publish succeeded but marking PROCESSED failed,
 * republishing outside that window produces a duplicate — consumers must be idempotent.
 */
import type { Logger } from "../logger";
import type { OutboxRecord } from "../models/outbox-record";
import type { OutboxProcessor } from "../outbox-processor";
import type { OutboxRepository } from "../outbox-repository";
import type { Publisher } from "../types";

export const DEFAULT_BATCH_SIZE = 100;

export type SweepSummary = { scanned: number; republished: number; failed: number };

export type SweepParams = {
	repository: Pick<OutboxRepository, "findStalePendingEvents" | "markAsFailed">;
	processor: Pick<OutboxProcessor, "processInserts">;
	publisher: Publisher;
	logger: Pick<Logger, "info" | "warn" | "error">;
	thresholdMinutes: number;
	batchSize?: number;
};

export const run = async ({
	repository,
	processor,
	publisher,
	logger,
	thresholdMinutes,
	batchSize = DEFAULT_BATCH_SIZE,
}: SweepParams): Promise<SweepSummary> => {
	const summary: SweepSummary = { scanned: 0, republished: 0, failed: 0 };
	// Records already handled in this run. A record the processor leaves PENDING (e.g. skipped
	// because it reached max attempts) is returned again by the next query; tracking ids keeps
	// it from being processed twice and guarantees the loop terminates.
	const seen = new Set<string>();

	logger.info({
		message: "Sweeping stale PENDING events",
		extra: { thresholdMinutes, batchSize },
	});

	while (true) {
		const batch = await repository.findStalePendingEvents({ olderThanMinutes: thresholdMinutes, limit: batchSize });
		const fresh = batch.filter((record) => !seen.has(record.id as string));

		if (!fresh.length) break;

		for (const record of fresh) {
			seen.add(record.id as string);
			summary.scanned++;
			if (await republish({ record, repository, processor, publisher, logger })) {
				summary.republished++;
			} else {
				summary.failed++;
			}
		}

		// A short batch means there was nothing beyond it when it was read.
		if (batch.length < batchSize) break;
	}

	logger.info({
		message: summary.scanned ? "Finished sweeping stale PENDING events" : "No stale PENDING events found",
		extra: summary,
	});

	return summary;
};

const republish = async ({
	record,
	repository,
	processor,
	publisher,
	logger,
}: Omit<SweepParams, "thresholdMinutes" | "batchSize"> & { record: OutboxRecord }): Promise<boolean> => {
	const id = record.id as string;
	const extra = { id, aggregateId: record.aggregateId, eventType: record.eventType, attempts: record.attempts };

	try {
		// prefetchedOutbox: undefined forces a fresh DB read, so a record processed meanwhile is skipped.
		await processor.processInserts({ insertedRecord: record, publisher, prefetchedOutbox: undefined });
		return true;
	} catch (error) {
		logger.error({ message: "Failed to republish stale PENDING event, marking it as FAILED", error, extra });
	}

	try {
		await repository.markAsFailed({
			id,
			attempts: record.attempts,
			retry: (error, attempt) => {
				logger.error({ message: "Error marking stale event as FAILED", error, extra: { ...extra, attempt } });
				return true;
			},
		});
	} catch (error) {
		logger.error({ message: "Could not mark stale event as FAILED", error, extra });
	}
	return false;
};

if (import.meta.main) {
	const { Pool } = await import("pg");
	const { getIntEnvOrDefault, loadCronConfig } = await import("../config");
	const { Logger } = await import("../logger");
	const { OutboxProcessor } = await import("../outbox-processor");
	const { OutboxRepository } = await import("../outbox-repository");
	const { loadPublisherConfig } = await import("../publisher-config");
	const { createPublisher } = await import("../publisher-factory");

	const logger = new Logger("outbox-reader:check-pending-events");
	let pool: InstanceType<typeof Pool> | undefined;
	let publisher: Publisher | undefined;
	let exitCode = 0;

	try {
		const cfg = loadCronConfig();
		const publisherConfig = await loadPublisherConfig(cfg.publisherConfigPath);

		pool = new Pool({ connectionString: cfg.connectionString });
		publisher = createPublisher(publisherConfig, logger);

		const repository = new OutboxRepository({
			pool,
			retryConfig: cfg.cronRetryConfig,
			columnNaming: cfg.columnNaming,
			tableName: cfg.tableName,
		});
		const processor = new OutboxProcessor({
			outboxRepository: repository,
			logger,
			maxAttempts: getIntEnvOrDefault("MAX_OUTBOX_ATTEMPTS", 5, { min: 1 }),
			columnNaming: cfg.columnNaming,
			tableName: cfg.tableName,
		});

		await run({
			repository,
			processor,
			publisher,
			logger,
			thresholdMinutes: cfg.pendingThresholdMinutes,
		});
	} catch (error) {
		logger.error({ message: "Stale PENDING sweep failed", error });
		exitCode = 1;
	} finally {
		await publisher?.close().catch((error) => logger.error({ message: "Error closing publisher", error }));
		await pool?.end().catch((error) => logger.error({ message: "Error closing DB pool", error }));
	}

	process.exit(exitCode);
}
