import { SharedDBClient } from "shared/database";

import { OutboxPrismaRepository } from "../outbox-repository";
import { RetryConfig } from "../types";
import { dbWriteRetryConfig } from "../config";

export const outboxRepositoryFactory = (retryConfig: RetryConfig = dbWriteRetryConfig): OutboxPrismaRepository => {
	const dbClient = new SharedDBClient();
	return new OutboxPrismaRepository(dbClient, retryConfig);
};
