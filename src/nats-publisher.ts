import { NatsConnection, connect } from "nats";
import { jetstream } from "@nats-io/jetstream";
import { backOff } from "exponential-backoff";

import { OutboxRecord } from "./models/outbox-record";
import { RetryCallback, RetryConfig } from "./types";
import { logger } from "./logger";
import { JitterType } from "exponential-backoff/dist/options";

export class NATSPublisher {
	private connection: NatsConnection | null = null;

	constructor(private readonly retryConfig: RetryConfig) {}

	async publish({ record, retry }: { record: OutboxRecord; retry: RetryCallback }): Promise<number> {
		if (!this.connection) {
			this.connection = await connect({
				servers: ["nats://localhost:4222"],
			});
		}

		const jc = jetstream(this.connection);

		try {
			logger.info({
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

			logger.info({
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
			logger.error({
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
}
