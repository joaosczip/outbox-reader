import "./telemetry";
import { Pool } from "pg";
import type { LogicalReplicationService } from "pg-logical-replication";

import { config, dbWriteRetryConfig, maxOutboxAttempts, retryQueueConfig } from "./config";
import { startHealthServer } from "./health";
import { Logger } from "./logger";
import { OutboxProcessor } from "./outbox-processor";
import { OutboxRepository } from "./outbox-repository";
import { loadPublisherConfig } from "./publisher-config";
import { createPublisher } from "./publisher-factory";
import { startReplication } from "./replication";
import { RetryQueue } from "./retry-queue";
import { shutdownTelemetry } from "./telemetry";
import type { Publisher } from "./types";
import { applyNamingToTableName } from "./utils/column-naming";
import { createWalChangeHandler } from "./wal-change-handler";

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

let replicationService: LogicalReplicationService | null = null;
let replicationHealthy = false;
let isShuttingDown = false;

// Readiness: only "ready" while replication is subscribed and error-free, the publisher
// is connected and the database answers.
healthServer.setReadinessCheck("replication", () => replicationHealthy);
healthServer.setReadinessCheck("publisher", () => (publisher ? (publisher.isConnected?.() ?? true) : false));
healthServer.setReadinessCheck("database", async () => {
	await pool.query("SELECT 1");
	return true;
});

/**
 * Graceful shutdown. Exits with code 1 when `failed` is true (fatal replication/startup
 * error) or when any shutdown step fails; with 0 otherwise.
 */
async function shutdown(signal: string, { failed = false }: { failed?: boolean } = {}): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;
	replicationHealthy = false;

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
	process.exit(failed || errors.length > 0 ? 1 : 0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

(async () => {
	const { connectionString, slotName } = config;
	const publisherConfig = await loadPublisherConfig(config.publisherConfigPath);
	publisher = createPublisher(publisherConfig, logger);

	await publisher.connect();

	retryQueue = new RetryQueue({
		processor: outboxProcessor,
		publisher: publisher as Publisher,
		outboxRepository,
		logger,
		config: retryQueueConfig,
		maxAttempts: maxOutboxAttempts,
		concurrency: config.dbPoolSize,
	});

	const onChange = createWalChangeHandler({
		processor: outboxProcessor,
		repository: outboxRepository,
		publisher,
		retryQueue,
		logger,
		concurrency: config.dbPoolSize,
	});

	replicationService = await startReplication({
		connectionString,
		slotName,
		// Physical table name (same naming as OutboxProcessor) so wal2json streams only outbox INSERTs.
		tableName: applyNamingToTableName(config.tableName, config.columnNaming),
		onChange,
		// Postgres acks are cumulative: acknowledging a later LSN would implicitly confirm a
		// failed one. Any replication/processing error is therefore fatal; the restarted
		// process resumes from the last confirmed LSN.
		onError: (error) => {
			replicationHealthy = false;
			if (isShuttingDown) return;
			logger.error({ message: "Replication error, shutting down to resume from the last confirmed LSN", error });
			void shutdown("replication-error", { failed: true });
		},
	});
	if (!isShuttingDown) replicationHealthy = true;
})().catch((error) => {
	logger.error({ message: "Error starting outbox reader", error });
	void shutdown("startup-failure", { failed: true });
});
