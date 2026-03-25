import { jetstream } from "@nats-io/jetstream";
import { type NatsConnection, connect } from "nats";

import type { Logger } from "./logger";
import { publishDuration } from "./metrics";
import type { OutboxRecord } from "./models/outbox-record";
import type { NATSConnectionConfig, Publisher, RetryConfig } from "./types";

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

	async connect(): Promise<void> {
		if (this.connection) {
			return;
		}

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

	async publish({ record }: { record: OutboxRecord }): Promise<number> {
		await this.connect();

		const jc = jetstream(this.connection as unknown as Parameters<typeof jetstream>[0]);

		const start = Date.now();
		try {
			this.logger.info({
				message: "Publishing message to NATS stream",
				extra: {
					eventType: record.eventType,
					aggregateId: record.aggregateId,
					aggregateType: record.aggregateType,
				},
			});
			const payload = typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload);
			const { seq } = await jc.publish(record.eventType, payload, { msgID: record.aggregateId });
			publishDuration.record(Date.now() - start, { "event.type": record.eventType, outcome: "success" });

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
			publishDuration.record(Date.now() - start, { "event.type": record.eventType, outcome: "error" });
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
