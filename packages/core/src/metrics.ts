import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("outbox-reader");

/** Number of WAL onChange calls received */
export const walEventsReceived = meter.createCounter("outbox.wal.events.received", {
	description: "Number of WAL onChange events received from the replication stream",
});

/** Number of outbox INSERT records extracted from WAL events */
export const recordsFiltered = meter.createCounter("outbox.records.filtered", {
	description: "Number of outbox INSERT records extracted from WAL events",
});

/** Number of records successfully published and marked PROCESSED */
export const recordsProcessed = meter.createCounter("outbox.records.processed", {
	description: "Number of outbox records successfully published and marked PROCESSED",
});

/** Number of records permanently marked FAILED after exhausting retries */
export const recordsFailed = meter.createCounter("outbox.records.failed", {
	description: "Number of outbox records permanently marked FAILED after exhausting all retry attempts",
});

/** Number of records skipped (already PROCESSED or max attempts reached) */
export const recordsSkipped = meter.createCounter("outbox.records.skipped", {
	description: "Number of outbox records skipped because they were already PROCESSED or exceeded max attempts",
});

/** End-to-end duration from WAL event receipt to PROCESSED/enqueued (ms) */
export const processingDuration = meter.createHistogram("outbox.record.processing.duration", {
	description: "End-to-end processing duration per outbox record from WAL event to PROCESSED or retry-enqueued",
	unit: "ms",
});

/** Duration of publisher.publish() call (ms) */
export const publishDuration = meter.createHistogram("outbox.publish.duration", {
	description: "Duration of the publisher.publish() call per outbox record",
	unit: "ms",
});

/** Current number of records waiting in the retry queue */
export const retryQueueSize = meter.createUpDownCounter("outbox.retry_queue.size", {
	description: "Current number of outbox records waiting in the in-memory retry queue",
});

/** Number of retry attempts dispatched by the RetryQueue */
export const retryAttempts = meter.createCounter("outbox.retry.attempts", {
	description: "Number of retry attempts dispatched by the RetryQueue",
});
