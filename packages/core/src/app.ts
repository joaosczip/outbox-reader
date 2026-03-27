import "./telemetry";
import pAll from "p-all";
import { Pool } from "pg";
import type { LogicalReplicationService, Wal2Json } from "pg-logical-replication";

import { config, dbWriteRetryConfig, maxOutboxAttempts, retryQueueConfig } from "./config";
import { processingDuration, recordsFiltered, walEventsReceived } from "./metrics";
import { shutdownTelemetry } from "./telemetry";
import { startHealthServer } from "./health";
import { Logger } from "./logger";
import { OutboxProcessor } from "./outbox-processor";
import { OutboxRepository } from "./outbox-repository";
import { loadPublisherConfig } from "./publisher-config";
import { createPublisher } from "./publisher-factory";
import { startReplication } from "./replication";
import { RetryQueue } from "./retry-queue";
import type { Publisher } from "./types";

const logger = new Logger("outbox-reader");
const healthServer = startHealthServer(); // binds PORT env var (default 4599)

const pool = new Pool({ connectionString: config.connectionString, max: config.dbPoolSize });
const outboxRepository = new OutboxRepository({
	pool,
	retryConfig: dbWriteRetryConfig,
	columnNaming: config.columnNaming,
	tableName: config.tableName,
});

const outboxProcessor = new OutboxProcessor({
	outboxRepository,
	logger,
	maxAttempts: maxOutboxAttempts,
	columnNaming: config.columnNaming,
	tableName: config.tableName,
});

let publisher: Publisher | null = null;
let retryQueue: RetryQueue | null = null;

const { connectionString, slotName } = config;

let replicationService: LogicalReplicationService | null = null;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;

	logger.info({ message: `Received ${signal}, starting graceful shutdown` });
	const errors: unknown[] = [];

	// 1. Stop health server immediately (drop readiness; important for k8s)
	try {
		healthServer.stop(true);
	} catch (err) {
		logger.error({ message: "Error stopping health server", error: err });
		errors.push(err);
	}

	// 2. Stop WAL replication (waits for the in-flight onChange to complete)
	if (replicationService) {
		try {
			logger.info({ message: "Stopping replication service" });
			await replicationService.stop();
			logger.info({ message: "Replication service stopped" });
		} catch (err) {
			logger.error({ message: "Error stopping replication service", error: err });
			errors.push(err);
		}
	}

	// 2.5. Stop retry queue (clears pending timers; records mid-retry stay PENDING)
	if (retryQueue) {
		try {
			retryQueue.stop();
		} catch (err) {
			logger.error({ message: "Error stopping retry queue", error: err });
			errors.push(err);
		}
	}

	// 3. Close publisher
	if (publisher) {
		try {
			await publisher.close();
		} catch (err) {
			logger.error({ message: "Error closing publisher connection", error: err });
			errors.push(err);
		}
	}

	// 4. End pg pool
	try {
		logger.info({ message: "Ending database pool" });
		await pool.end();
		logger.info({ message: "Database pool ended" });
	} catch (err) {
		logger.error({ message: "Error ending database pool", error: err });
		errors.push(err);
	}

	// 5. Flush and shutdown OTeL (must be last to capture all preceding telemetry)
	try {
		await shutdownTelemetry();
	} catch (err) {
		logger.error({ message: "Error shutting down telemetry", error: err });
		errors.push(err);
	}

	logger.info({ message: "Graceful shutdown complete" });
	process.exit(errors.length > 0 ? 1 : 0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

(async () => {
	const publisherConfig = await loadPublisherConfig(config.publisherConfigPath);
	publisher = createPublisher(publisherConfig, logger);

	await publisher.connect();

	retryQueue = new RetryQueue({
		processor: outboxProcessor,
		publisher: publisher as Publisher,
		outboxRepository,
		logger,
		config: retryQueueConfig,
	});

	replicationService = await startReplication({
		connectionString,
		slotName,
		onChange: async (log: Wal2Json.Output) => {
			walEventsReceived.add(1);

			const outboxRecords = outboxProcessor.filterChanges(log);
			recordsFiltered.add(outboxRecords.length);

			const ids = outboxRecords.map((r) => r.id as string);
			const fetchedRecords = await outboxRepository.findUnprocessedByIds(ids);
			const fetchedMap = new Map(fetchedRecords.map((r) => [r.id, r]));

			const activePublisher = publisher as Publisher;
			await pAll(
				outboxRecords.map((record) => async () => {
					const start = Date.now();
					try {
						await outboxProcessor.processInserts({
							insertedRecord: record,
							prefetchedOutbox: fetchedMap.get(record.id as string) ?? null,
							publisher: activePublisher,
						});
						processingDuration.record(Date.now() - start, { "event.type": record.eventType });
					} catch (error) {
						processingDuration.record(Date.now() - start, { "event.type": record.eventType });
						logger.error({
							message: `Outbox record ${record.id} failed on first attempt, enqueueing for retry`,
							extra: { recordId: record.id },
							error,
						});
						retryQueue?.enqueue(record);
					}
				}),
				{ concurrency: config.dbPoolSize },
			);
		},
	});
})().catch((error) => logger.error({ message: "Error starting replication", error }));
