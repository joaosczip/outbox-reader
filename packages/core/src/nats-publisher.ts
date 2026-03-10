import { jetstream } from "@nats-io/jetstream";
import { backOff } from "exponential-backoff";
import { type NatsConnection, connect } from "nats";

import type { JitterType } from "exponential-backoff/dist/options";
import type { Logger } from "./logger";
import type { OutboxRecord } from "./models/outbox-record";
import type { NATSConnectionConfig, Publisher, RetryCallback, RetryConfig } from "./types";

export class NATSPublisher implements Publisher {
	private connection: NatsConnection | null = null;
	readonly retryConfig: RetryConfig;
	private logger: Logger;
	private connectionConfig: NATSConnectionConfig;

	constructor({
		retryConfig,
		logger,
		connectionConfig,
	}: {
		retryConfig: RetryConfig;
		logger: Logger;
		connectionConfig: NATSConnectionConfig;
	}) {
		this.retryConfig = retryConfig;
		this.logger = logger;
		this.connectionConfig = connectionConfig;
	}

	async publish({ record, retry }: { record: OutboxRecord; retry: RetryCallback }): Promise<number> {
		if (!this.connection) {
			this.logger.info({
				message: "Establishing NATS connection",
				extra: {
					servers: this.connectionConfig.servers,
					name: this.connectionConfig.name,
				},
			});

			this.connection = await connect(this.connectionConfig);

			this.logger.info({
				message: "NATS connection established successfully",
			});
		}

		const jc = jetstream(this.connection as unknown as Parameters<typeof jetstream>[0]);

		try {
			this.logger.info({
				message: "Publishing message to NATS stream",
				extra: {
					eventType: record.eventType,
					aggregateId: record.aggregateId,
					aggregateType: record.aggregateType,
				},
			});
			const { seq } = await backOff(
				async () => jc.publish(record.eventType, record.payload as string, { msgID: record.aggregateId }),
				{
					maxDelay: this.retryConfig.maxDelayInMs,
					numOfAttempts: this.retryConfig.numOfAttempts,
					jitter: this.retryConfig.jitter as JitterType,
					startingDelay: this.retryConfig.startingDelayInMs,
					retry,
				},
			);

			this.logger.info({
				message: "Published message to NATS stream",
				extra: {
					eventType: record.eventType,
					aggregateId: record.aggregateId,
					aggregateType: record.aggregateType,
					sequenceNumber: seq,
				},
			});

			return seq;
		} catch (error) {
			this.logger.error({
				message: "Error publishing message to NATS stream",
				extra: {
					eventType: record.eventType,
					aggregateId: record.aggregateId,
					aggregateType: record.aggregateType,
				},
				error,
			});
			throw error;
		}
	}

	/**
	 * Gracefully close the NATS connection
	 */
	async close(): Promise<void> {
		if (this.connection) {
			this.logger.info({
				message: "Closing NATS connection",
			});

			await this.connection.close();
			this.connection = null;

			this.logger.info({
				message: "NATS connection closed",
			});
		}
	}

	/**
	 * Check if the NATS connection is established
	 */
	isConnected(): boolean {
		return this.connection !== null && !this.connection.isClosed();
	}
}
