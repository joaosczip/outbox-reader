import type { Logger } from "./logger";
import { NATSPublisher } from "./nats-publisher";
import { type PublisherConfig, notImplementedMessage } from "./publisher-config";
import type { Publisher } from "./types";

export function createPublisher(config: PublisherConfig, logger: Logger): Publisher {
	switch (config.provider) {
		case "nats": {
			const { subjectPrefix, ...connectionConfig } = config.options;
			return new NATSPublisher({
				logger,
				retryConfig: config.retryConfig,
				connectionConfig,
				subjectPrefix,
			});
		}
		case "sqs":
		case "kafka":
			throw new Error(notImplementedMessage(config.provider));
		default: {
			const _exhaustive: never = config;
			throw new Error(`Unknown publisher provider: ${(_exhaustive as { provider: string }).provider}`);
		}
	}
}
