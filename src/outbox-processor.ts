import { Wal2Json } from "pg-logical-replication";
import { OutboxConstructor, OutboxRecord } from "./models/outbox-record";
import { OutboxRepository } from "./outbox-repository";
import { Logger } from "./logger";
import { Publisher } from "./types";

export class OutboxProcessor {
	private outboxRepository: OutboxRepository;
	private logger: Logger;

	constructor({ outboxRepository, logger }: { outboxRepository: OutboxRepository; logger: Logger }) {
		this.outboxRepository = outboxRepository;
		this.logger = logger;
	}

	async processInserts({
		insertedRecord: record,
		publisher,
	}: {
		insertedRecord: OutboxRecord;
		publisher: Publisher;
	}) {
		try {
			const outbox = await this.outboxRepository.findUnprocessedById(record.id as string);

			if (!outbox || outbox.status === "PROCESSED") {
				this.logger.info({
					message: `Outbox record ${record.id} already processed`,
					extra: { recordId: record.id },
				});
				return;
			}

			if (outbox.attempts >= publisher.retryConfig.numOfAttempts) {
				this.logger.warn({
					message: `Outbox record ${record.id} reached max attempts`,
					extra: { recordId: record.id, attempts: outbox.attempts },
				});
				return;
			}

			const sequenceNumber = await publisher.publish({
				record: outbox as OutboxRecord,
				retry: (e, attempts) => {
					this.logger.error({
						message: `Error publishing NATS message`,
						extra: { recordId: record.id, attempts },
						error: e,
					});
					return true;
				},
			});

			await this.outboxRepository.markAsProcessed({
				id: outbox.id,
				sequenceNumber,
				attempts: outbox.attempts,
				retry: (e, attempts) => {
					this.logger.error({
						message: `Error marking outbox record ${record.id} as processed`,
						extra: { recordId: record.id, attempts },
						error: e,
					});
					return true;
				},
			});
		} catch (error) {
			this.logger.error({ message: `Error processing outbox record ${record.id}`, error });

			await this.outboxRepository.markAsFailed({
				id: record.id as string,
				attempts: record.attempts,
				retry: (e, attempts) => {
					this.logger.error({
						message: `Error processing outbox record ${record.id}`,
						extra: { recordId: record.id, attempts },
						error: e,
					});
					return true;
				},
			});
		}
	}

	filterChanges(log: Wal2Json.Output) {
		const onlyInsertsOnOutbox = ({ table, columnnames, kind }: Wal2Json.Change) =>
			table === "outbox" && kind === "insert" && columnnames?.length;

		const insertToOutboxEntity = ({ columnnames, columnvalues }: Wal2Json.Change) => {
			const columnNamesMapping: Record<string, string> = {
				aggregate_id: "aggregateId",
				aggregate_type: "aggregateType",
				event_type: "eventType",
				created_at: "createdAt",
				processed_at: "processedAt",
			};

			const outboxAttributes = columnnames.reduce((acc: Partial<OutboxConstructor>, dbColumn: string, index) => {
				const outboxColumn = columnNamesMapping[dbColumn as keyof OutboxConstructor] || dbColumn;
				(acc as any)[outboxColumn as keyof OutboxConstructor] = columnvalues[index];
				return acc;
			}, {} as Partial<OutboxConstructor>);

			this.logger.info({
				message: "Received replication data for an outbox record",
				extra: {
					recordId: outboxAttributes.id,
					aggregateId: outboxAttributes.aggregateId,
					aggregateType: outboxAttributes.aggregateType,
					eventType: outboxAttributes.eventType,
				},
			});

			return new OutboxRecord(outboxAttributes as OutboxConstructor);
		};

		return log.change.filter(onlyInsertsOnOutbox).map(insertToOutboxEntity);
	}
}
