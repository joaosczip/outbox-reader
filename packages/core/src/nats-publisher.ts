import { type JetStreamClient, type JetStreamPublishOptions, jetstream } from "@nats-io/jetstream";
import { type NatsConnection, connect, headers } from "nats";

import type { Logger } from "./logger";
import { publishDuration } from "./metrics";
import type { OutboxRecord } from "./models/outbox-record";
import type { NATSConnectionConfig, Publisher, RetryConfig } from "./types";

/** NATS header names carrying the outbox record metadata (Nats-Msg-Id is set from record.id via msgID). */
export const OUTBOX_HEADERS = {
	id: "Outbox-Id",
	aggregateId: "Outbox-Aggregate-Id",
	aggregateType: "Outbox-Aggregate-Type",
	eventType: "Outbox-Event-Type",
	createdAt: "Outbox-Created-At",
} as const;

const buildOutboxHeaders = (record: OutboxRecord): JetStreamPublishOptions["headers"] => {
	const hdrs = headers();
	if (record.id) hdrs.set(OUTBOX_HEADERS.id, record.id);
	hdrs.set(OUTBOX_HEADERS.aggregateId, record.aggregateId);
	hdrs.set(OUTBOX_HEADERS.aggregateType, record.aggregateType);
	hdrs.set(OUTBOX_HEADERS.eventType, record.eventType);
	if (record.createdAt) hdrs.set(OUTBOX_HEADERS.createdAt, record.createdAt.toISOString());
	// The connection is a `nats` v2 client: it encodes these headers itself, so the
	// @nats-io/jetstream MsgHdrs type is only a nominal mismatch.
	return hdrs as unknown as JetStreamPublishOptions["headers"];
};

export class NATSPublisher implements Publisher {
	private connection: NatsConnection | null = null;
	/** Created once per connection and reused by every publish; reset on close(). */
	private jetStreamClient: JetStreamClient | null = null;
	readonly retryConfig: RetryConfig;
	private logger: Logger;
	private connectionConfig: NATSConnectionConfig;
	private subjectPrefix: string;

	constructor({
		retryConfig,
		logger,
		connectionConfig,
		subjectPrefix,
	}: {
		retryConfig: RetryConfig;
		logger: Logger;
		connectionConfig: NATSConnectionConfig;
		subjectPrefix: string;
	}) {
		this.retryConfig = retryConfig;
		this.logger = logger;
		this.connectionConfig = connectionConfig;
		this.subjectPrefix = subjectPrefix;
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
		this.jetStreamClient = jetstream(this.connection as unknown as Parameters<typeof jetstream>[0]);

		this.logger.info({
			message: "NATS connection established successfully",
		});
	}

	async publish({ record }: { record: OutboxRecord }): Promise<number> {
		await this.connect();

		const jc = this.jetStreamClient as JetStreamClient;

		const subject = `${this.subjectPrefix}.${record.eventType}`;
		const start = Date.now();
		try {
			const payload = typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload);
			// msgID must be unique per event: JetStream drops messages with a repeated msgID inside the
			// duplicate window. record.id keeps retries of the same record deduplicated while letting
			// distinct events of the same aggregate through.
			const { seq, duplicate } = await jc.publish(subject, payload, {
				msgID: record.id,
				headers: buildOutboxHeaders(record),
			});
			publishDuration.record(Date.now() - start, { "event.type": record.eventType, outcome: "success" });

			if (duplicate) {
				this.logger.warn({
					message: "NATS reported message as duplicate; already published for this record id",
					extra: {
						subject,
						id: record.id,
						aggregateId: record.aggregateId,
						aggregateType: record.aggregateType,
						sequenceNumber: seq,
					},
				});
			}

			this.logger.debug({
				message: "Published message to NATS stream",
				extra: {
					subject,
					id: record.id,
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
					subject,
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
			this.jetStreamClient = null;

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
