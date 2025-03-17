import { OutboxRecord } from "../models/outbox-record";
import { RetryCallback, RetryConfig } from "./retry-config";

export interface Publisher {
	get retryConfig(): RetryConfig;

	publish: (params: { record: OutboxRecord; retry: RetryCallback }) => Promise<number>;
}
