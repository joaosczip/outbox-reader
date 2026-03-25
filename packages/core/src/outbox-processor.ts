import type { Wal2Json } from "pg-logical-replication";
import type { Logger } from "./logger";
import { recordsProcessed, recordsSkipped } from "./metrics";
import { type OutboxConstructor, OutboxRecord } from "./models/outbox-record";
import type { OutboxRepository } from "./outbox-repository";
import type { Publisher } from "./types";
import { type ColumnNaming, applyNamingToTableName, getColumnNames } from "./utils/column-naming";

export class OutboxProcessor {
	private outboxRepository: OutboxRepository;
	private logger: Logger;
	private maxAttempts: number;
	private columnNaming: ColumnNaming;
	private tableName: string;

	constructor({
		outboxRepository,
		logger,
		maxAttempts,
		columnNaming = "snake_case",
		tableName = "outbox",
	}: {
		outboxRepository: OutboxRepository;
		logger: Logger;
		maxAttempts: number;
		columnNaming?: ColumnNaming;
		tableName?: string;
	}) {
		this.outboxRepository = outboxRepository;
		this.logger = logger;
		this.maxAttempts = maxAttempts;
		this.columnNaming = columnNaming;
		this.tableName = applyNamingToTableName(tableName, columnNaming);
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
			recordsSkipped.add(1, { reason: "already_processed" });
			return;
		}

		if (outbox.attempts >= this.maxAttempts) {
			this.logger.warn({
				message: `Outbox record ${record.id} reached max attempts`,
				extra: { recordId: record.id, attempts: outbox.attempts },
			});
			recordsSkipped.add(1, { reason: "max_attempts_exceeded" });
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
		recordsProcessed.add(1, { "event.type": outbox.eventType });
	}

	filterChanges(log: Wal2Json.Output) {
		const tableName = this.tableName;
		const cols = getColumnNames(this.columnNaming);

		const columnNamesMapping: Record<string, string> = {
			[cols.aggregateId]: "aggregateId",
			[cols.aggregateType]: "aggregateType",
			[cols.eventType]: "eventType",
			[cols.createdAt]: "createdAt",
			[cols.processedAt]: "processedAt",
			[cols.sequenceNumber]: "sequenceNumber",
		};

		const onlyInsertsOnOutbox = ({ table, columnnames, kind }: Wal2Json.Change) =>
			table === tableName && kind === "insert" && columnnames?.length;

		const insertToOutboxEntity = ({ columnnames, columnvalues }: Wal2Json.Change) => {
			const outboxAttributes = columnnames.reduce(
				(acc: Partial<OutboxConstructor>, dbColumn: string, index) => {
					const outboxColumn = columnNamesMapping[dbColumn] || dbColumn;
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
