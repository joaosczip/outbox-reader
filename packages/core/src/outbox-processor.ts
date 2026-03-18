import type { Wal2Json } from "pg-logical-replication";
import type { Logger } from "./logger";
import { type OutboxConstructor, OutboxRecord } from "./models/outbox-record";
import type { OutboxRepository } from "./outbox-repository";
import type { Publisher } from "./types";

export class OutboxProcessor {
	private outboxRepository: OutboxRepository;
	private logger: Logger;
	private maxAttempts: number;

	constructor({
		outboxRepository,
		logger,
		maxAttempts,
	}: {
		outboxRepository: OutboxRepository;
		logger: Logger;
		maxAttempts: number;
	}) {
		this.outboxRepository = outboxRepository;
		this.logger = logger;
		this.maxAttempts = maxAttempts;
	}

	async processInserts({
		insertedRecord: record,
		publisher,
		prefetchedOutbox,
	}: {
		insertedRecord: OutboxRecord;
		publisher: Publisher;
		prefetchedOutbox?: OutboxRecord | null;
	}) {
		const outbox =
			prefetchedOutbox !== undefined
				? prefetchedOutbox
				: await this.outboxRepository.findUnprocessedById(record.id as string);

		if (!outbox || outbox.status === "PROCESSED") {
			this.logger.info({
				message: `Outbox record ${record.id} already processed`,
				extra: { recordId: record.id },
			});
			return;
		}

		if (outbox.attempts >= this.maxAttempts) {
			this.logger.warn({
				message: `Outbox record ${record.id} reached max attempts`,
				extra: { recordId: record.id, attempts: outbox.attempts },
			});
			return;
		}

		const sequenceNumber = await publisher.publish({ record: outbox });

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
				sequence_number: "sequenceNumber",
			};

			const outboxAttributes = columnnames.reduce(
				(acc: Partial<OutboxConstructor>, dbColumn: string, index) => {
					const outboxColumn = columnNamesMapping[dbColumn as keyof OutboxConstructor] || dbColumn;
					(acc as Record<string, unknown>)[outboxColumn] = columnvalues[index];
					return acc;
				},
				{} as Partial<OutboxConstructor>,
			);

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
