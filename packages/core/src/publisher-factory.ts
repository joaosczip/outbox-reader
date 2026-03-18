import type { Logger } from "./logger";
import { NATSPublisher } from "./nats-publisher";
import type { PublisherConfig } from "./publisher-config";
import type { Publisher } from "./types";

export function createPublisher(config: PublisherConfig, logger: Logger): Publisher {
	switch (config.provider) {
		case "nats":
			return new NATSPublisher({
				logger,
				retryConfig: config.retryConfig,
				connectionConfig: config.options,
			});
		case "sqs":
			throw new Error("Publisher provider 'sqs' is not yet implemented");
		case "kafka":
			throw new Error("Publisher provider 'kafka' is not yet implemented");
		default: {
			const _exhaustive: never = config;
			throw new Error(`Unknown publisher provider: ${(_exhaustive as { provider: string }).provider}`);
		}
	}
}
