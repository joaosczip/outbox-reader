import { beforeEach, describe, expect, it } from "bun:test";
import type { Logger } from "../src/logger";
import { NATSPublisher } from "../src/nats-publisher";
import type { KafkaPublisherConfig, NATSPublisherConfig, SQSPublisherConfig } from "../src/publisher-config";
import { createPublisher } from "../src/publisher-factory";
import { MockLogger } from "./mocks/mock-logger";

const retryConfig = {
	jitter: "full" as const,
	maxDelayInMs: 5000,
	numOfAttempts: 5,
	startingDelayInMs: 500,
};

describe("createPublisher", () => {
	let logger: Logger;

	beforeEach(() => {
		logger = new MockLogger() as unknown as Logger;
	});

	describe("nats provider", () => {
		it("returns a NATSPublisher instance", () => {
			const cfg: NATSPublisherConfig = {
				provider: "nats",
				retryConfig,
				options: { servers: "nats://localhost:4222", subjectPrefix: "events" },
			};
			expect(createPublisher(cfg, logger)).toBeInstanceOf(NATSPublisher);
		});

		it("wires retryConfig onto the publisher", () => {
			const cfg: NATSPublisherConfig = {
				provider: "nats",
				retryConfig,
				options: { servers: "nats://localhost:4222", subjectPrefix: "events" },
			};
			expect(createPublisher(cfg, logger).retryConfig).toEqual(retryConfig);
		});
	});

	describe("unimplemented providers", () => {
		it("throws for sqs", () => {
			const cfg: SQSPublisherConfig = {
				provider: "sqs",
				retryConfig,
				options: { region: "us-east-1", queueUrl: "https://sqs.amazonaws.com/1/q" },
			};
			expect(() => createPublisher(cfg, logger)).toThrow("'sqs' is not yet implemented");
		});

		it("throws for kafka", () => {
			const cfg: KafkaPublisherConfig = {
				provider: "kafka",
				retryConfig,
				options: { brokers: ["localhost:9092"] },
			};
			expect(() => createPublisher(cfg, logger)).toThrow("'kafka' is not yet implemented");
		});
	});
});
