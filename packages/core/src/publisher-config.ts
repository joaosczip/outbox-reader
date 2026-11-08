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
const JITTER_VALUES = ["full", "none"] as const;

type Obj = Record<string, unknown>;

const showValue = (value: unknown): string => (value === undefined ? "undefined" : JSON.stringify(value));

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, path: string): Obj => {
	if (!isObject(value)) {
		throw new Error(`"${path}" must be an object (got ${showValue(value)})`);
	}
	return value;
};

const requireNonEmptyString = (value: unknown, path: string): void => {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`"${path}" must be a non-empty string (got ${showValue(value)})`);
	}
};

const requireNonEmptyStringArray = (value: unknown, path: string): void => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`"${path}" must be a non-empty array of strings (got ${showValue(value)})`);
	}
	value.forEach((item, i) => requireNonEmptyString(item, `${path}[${i}]`));
};

const TYPE_CHECKS = {
	string: (value: unknown) => typeof value === "string",
	number: (value: unknown) => typeof value === "number" && Number.isFinite(value),
	boolean: (value: unknown) => typeof value === "boolean",
} as const;

const optionalOfType = (obj: Obj, key: string, type: keyof typeof TYPE_CHECKS, path: string): void => {
	if (!(key in obj)) return;
	const value = obj[key];
	if (!TYPE_CHECKS[type](value)) {
		throw new Error(`"${path}.${key}" must be a ${type} when set (got ${showValue(value)})`);
	}
};

const validateRetryConfig = (value: unknown): void => {
	const retry = requireObject(value, "retryConfig");
	const { numOfAttempts, startingDelayInMs, maxDelayInMs, jitter } = retry;
	if (typeof numOfAttempts !== "number" || !Number.isInteger(numOfAttempts) || numOfAttempts < 1) {
		throw new Error(`"retryConfig.numOfAttempts" must be an integer >= 1 (got ${showValue(numOfAttempts)})`);
	}
	if (
		"startingDelayInMs" in retry &&
		(typeof startingDelayInMs !== "number" || !Number.isFinite(startingDelayInMs) || startingDelayInMs < 0)
	) {
		throw new Error(`"retryConfig.startingDelayInMs" must be a number >= 0 (got ${showValue(startingDelayInMs)})`);
	}
	if (typeof maxDelayInMs !== "number" || !Number.isFinite(maxDelayInMs) || maxDelayInMs < 0) {
		throw new Error(`"retryConfig.maxDelayInMs" must be a number >= 0 (got ${showValue(maxDelayInMs)})`);
	}
	if (!JITTER_VALUES.includes(jitter as (typeof JITTER_VALUES)[number])) {
		throw new Error(`"retryConfig.jitter" must be one of: ${JITTER_VALUES.join(", ")} (got ${showValue(jitter)})`);
	}
};

const validateNatsOptions = (options: Obj): void => {
	const { servers } = options;
	if (Array.isArray(servers)) {
		requireNonEmptyStringArray(servers, "options.servers");
	} else if (typeof servers !== "string" || servers.trim() === "") {
		throw new Error(
			`"options.servers" must be a non-empty string or a non-empty array of strings (got ${showValue(servers)})`,
		);
	}
	requireNonEmptyString(options.subjectPrefix, "options.subjectPrefix");
	for (const key of ["name", "user", "pass", "token"]) optionalOfType(options, key, "string", "options");
	for (const key of ["maxReconnectAttempts", "reconnectTimeWait", "timeout"])
		optionalOfType(options, key, "number", "options");
	for (const key of ["verbose", "pedantic"]) optionalOfType(options, key, "boolean", "options");
};

const validateSqsOptions = (options: Obj): void => {
	requireNonEmptyString(options.region, "options.region");
	requireNonEmptyString(options.queueUrl, "options.queueUrl");
};

const validateKafkaOptions = (options: Obj): void => {
	requireNonEmptyStringArray(options.brokers, "options.brokers");
	optionalOfType(options, "clientId", "string", "options");
};

const OPTIONS_VALIDATORS: Record<(typeof KNOWN_PROVIDERS)[number], (options: Obj) => void> = {
	nats: validateNatsOptions,
	sqs: validateSqsOptions,
	kafka: validateKafkaOptions,
};

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

	const cfg = (isObject(parsed) ? parsed : {}) as Obj;
	const provider = cfg.provider;

	if (!KNOWN_PROVIDERS.includes(provider as (typeof KNOWN_PROVIDERS)[number])) {
		throw new Error(`Unknown publisher provider "${provider}". Must be one of: ${KNOWN_PROVIDERS.join(", ")}`);
	}

	try {
		validateRetryConfig(cfg.retryConfig);
		OPTIONS_VALIDATORS[provider as (typeof KNOWN_PROVIDERS)[number]](requireObject(cfg.options, "options"));
	} catch (cause) {
		throw new Error(
			`Invalid publisher config at "${filePath}" (provider "${provider}"): ${(cause as Error).message}`,
		);
	}

	return cfg as PublisherConfig;
}
