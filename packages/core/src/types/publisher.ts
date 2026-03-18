import type { OutboxRecord } from "../models/outbox-record";
import type { RetryConfig } from "./retry-config";

export interface Publisher {
	// retryConfig is retained for future consumers (e.g. RetryQueue) that may
	// want to reuse the publisher's configured backoff parameters.
	get retryConfig(): RetryConfig;
	connect(): Promise<void>;
	close(): Promise<void>;
	publish: (params: { record: OutboxRecord }) => Promise<number>;
}
