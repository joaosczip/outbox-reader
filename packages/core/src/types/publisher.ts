import type { OutboxRecord } from "../models/outbox-record";
import type { RetryCallback, RetryConfig } from "./retry-config";

export interface Publisher {
	get retryConfig(): RetryConfig;
	connect(): Promise<void>;
	close(): Promise<void>;
	publish: (params: { record: OutboxRecord; retry: RetryCallback }) => Promise<number>;
}
