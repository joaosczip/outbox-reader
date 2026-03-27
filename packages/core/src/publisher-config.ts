import { readFile } from "node:fs/promises";
import type { RetryConfig } from "./types";

export type NATSPublisherConfig = {
	provider: "nats";
	retryConfig: RetryConfig;
	// Reuses NATSConnectionConfig shape — passed directly to NATSPublisher constructor
	options: {
		servers: string | string[];
		subjectPrefix: string;
		name?: string;
		user?: string;
		pass?: string;
		token?: string;
		maxReconnectAttempts?: number;
		reconnectTimeWait?: number;
		timeout?: number;
		verbose?: boolean;
		pedantic?: boolean;
	};
};

export type SQSPublisherConfig = {
	provider: "sqs";
	retryConfig: RetryConfig;
	options: { region: string; queueUrl: string };
};

export type KafkaPublisherConfig = {
	provider: "kafka";
	retryConfig: RetryConfig;
	options: { brokers: string[]; clientId?: string };
};

export type PublisherConfig = NATSPublisherConfig | SQSPublisherConfig | KafkaPublisherConfig;

const KNOWN_PROVIDERS = ["nats", "sqs", "kafka"] as const;

export async function loadPublisherConfig(filePath: string): Promise<PublisherConfig> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (cause) {
		throw new Error(`Failed to read publisher config at "${filePath}": ${(cause as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(raw);
	} catch (cause) {
		throw new Error(`Failed to parse publisher config YAML at "${filePath}": ${(cause as Error).message}`);
	}

	const cfg = parsed as Record<string, unknown>;
	const provider = cfg?.provider;

	if (!KNOWN_PROVIDERS.includes(provider as (typeof KNOWN_PROVIDERS)[number])) {
		throw new Error(`Unknown publisher provider "${provider}". Must be one of: ${KNOWN_PROVIDERS.join(", ")}`);
	}

	return cfg as PublisherConfig;
}
