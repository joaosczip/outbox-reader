import { PrismaClient } from "@prisma/client";
import { backOff } from "exponential-backoff";
import { DateTime } from "luxon";

import { SharedDBClient } from "shared/database";
import { RetryCallback, RetryConfig } from "./types";
import { JitterType } from "exponential-backoff/dist/options";
import { OutboxRecord } from "./models/outbox-record";

type UpdateOutboxRecordParams = {
	id: string;
	sequenceNumber: number;
	attempts: number;
	retry: RetryCallback;
};

export class OutboxPrismaRepository extends SharedDBClient {
	constructor(
		private dbClient: PrismaClient,
		private retryConfig: RetryConfig,
	) {
		super();
	}

	async findUnprocessedById(id: string) {
		return this.dbClient.outbox.findFirst({
			where: {
				id,
				status: {
					in: ["PENDING", "FAILED"],
				},
			},
		});
	}

	async findFailedEvents() {
		return this.dbClient.outbox.findMany({
			where: {
				status: "FAILED",
			},
		});
	}

	async findRecentPendingEvents(minutes = 10) {
		return this.dbClient.outbox.findMany({
			where: {
				createdAt: {
					gte: DateTime.now().minus({ minutes }).toJSDate(),
				},
				status: "PENDING",
			},
			orderBy: {
				createdAt: "asc",
			},
		});
	}

	async findLastProcessedEvent(): Promise<OutboxRecord | null> {
		const lastProcessedEvent = await this.dbClient.outbox.findFirst({
			orderBy: {
				sequenceNumber: "desc",
			},
			where: {
				status: "PROCESSED",
			},
		});

		return lastProcessedEvent
			? new OutboxRecord({
					...lastProcessedEvent,
					status: lastProcessedEvent.status as any,
					sequenceNumber: lastProcessedEvent.sequenceNumber as number,
					createdAt: lastProcessedEvent.createdAt.toISOString(),
					processedAt: (lastProcessedEvent.processedAt as Date).toISOString(),
				})
			: null;
	}

	async markAsProcessed({ id, sequenceNumber, attempts, retry }: UpdateOutboxRecordParams): Promise<void> {
		await backOff(
			async () =>
				this.dbClient.outbox.update({
					where: {
						id,
						attempts,
					},
					data: {
						status: "PROCESSED",
						processedAt: new Date(),
						attempts: {
							increment: 1,
						},
						sequenceNumber,
					},
				}),
			{
				retry,
				startingDelay: this.retryConfig.startingDelayInMs,
				jitter: this.retryConfig.jitter as JitterType,
				maxDelay: this.retryConfig.maxDelayInMs,
				numOfAttempts: this.retryConfig.numOfAttempts,
			},
		);
	}

	async markAsFailed({ id, attempts, retry }: Omit<UpdateOutboxRecordParams, "sequenceNumber">): Promise<void> {
		await backOff(
			async () =>
				this.dbClient.outbox.update({
					where: {
						id,
						attempts,
					},
					data: {
						status: "FAILED",
						attempts: {
							increment: 1,
						},
					},
				}),
			{
				retry,
				startingDelay: this.retryConfig.startingDelayInMs,
				jitter: this.retryConfig.jitter as JitterType,
				maxDelay: this.retryConfig.maxDelayInMs,
				numOfAttempts: this.retryConfig.numOfAttempts,
			},
		);
	}
}
