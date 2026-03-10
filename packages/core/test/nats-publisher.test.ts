import { Logger } from "../src/logger";
import { NATSPublisher } from "../src/nats-publisher";
import type { RetryConfig } from "../src/types";

describe("NATSPublisher", () => {
	const retryConfig: RetryConfig = {
		jitter: "full",
		maxDelayInMs: 10000,
		numOfAttempts: 10,
		startingDelayInMs: 1000,
	};

	it("should instantiate with connection config", () => {
		const logger = new Logger("test");
		const connectionConfig = {
			servers: ["nats://localhost:4222"],
			name: "test-publisher",
		};

		const publisher = new NATSPublisher({
			retryConfig,
			logger,
			connectionConfig,
		});

		expect(publisher).toBeInstanceOf(NATSPublisher);
		expect(publisher.isConnected()).toBe(false);
	});

	it("should accept multiple servers in configuration", () => {
		const logger = new Logger("test");
		const connectionConfig = {
			servers: ["nats://server1:4222", "nats://server2:4222"],
			name: "test-publisher",
			user: "testuser",
			pass: "testpass",
			maxReconnectAttempts: 5,
			reconnectTimeWait: 1000,
		};

		const publisher = new NATSPublisher({
			retryConfig,
			logger,
			connectionConfig,
		});

		expect(publisher).toBeInstanceOf(NATSPublisher);
	});
});
