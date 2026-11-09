import type { Wal2Json } from "pg-logical-replication";
import type { Logger } from "./logger";
import { optimisticLockMisses, recordsDead, recordsProcessed, recordsSkipped } from "./metrics";
import { type OutboxConstructor, OutboxRecord } from "./models/outbox-record";
import type { OutboxRepository } from "./outbox-repository";
import type { Publisher } from "./types";
import { type ColumnNaming, applyNamingToTableName, getColumnNames } from "./utils/column-naming";

/** Outcome of one `processInserts` attempt. Callers that do not branch on it may ignore the value. */
export type ProcessInsertsResult = "published" | "already_processed" | "dead" | "blocked" | "lock_miss";

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
	}): Promise<ProcessInsertsResult> {
		const outbox =
			prefetchedOutbox !== undefined
				? prefetchedOutbox
				: await this.outboxRepository.findUnprocessedById(record.id as string);

		if (!outbox || outbox.status === "PROCESSED") {
			this.logger.debug({
				message: `Outbox record ${record.id} already processed`,
				extra: { recordId: record.id },
			});
			recordsSkipped.add(1, { reason: "already_processed" });
			return "already_processed";
		}

		if (outbox.attempts >= this.maxAttempts) {
			recordsSkipped.add(1, { reason: "max_attempts_exceeded" });
			const markedDead = await this.markAsDead(outbox);
			return markedDead ? "dead" : "lock_miss";
		}

		// DEAD is terminal and does not block successors. After the head is marked DEAD, the tail
		// may be published. Only an older PENDING or FAILED sibling blocks; FAILED keeps blocking
		// until that head is requeued and published, or becomes DEAD. PROCESSED siblings do not.
		if (await this.outboxRepository.hasOlderPendingOrFailed(outbox)) {
			this.logger.debug({
				message: `Outbox record ${record.id} is blocked by an older PENDING or FAILED sibling`,
				extra: { recordId: record.id, aggregateId: outbox.aggregateId },
			});
			return "blocked";
		}

		const sequenceNumber = await publisher.publish({ record: outbox });

		const marked = await this.outboxRepository.markAsProcessed({
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

		if (!marked) {
			this.logger.warn({
				message: `Outbox record ${record.id} was not marked as PROCESSED: optimistic-lock miss (record changed concurrently)`,
				extra: { recordId: record.id, attempts: outbox.attempts, sequenceNumber },
			});
			optimisticLockMisses.add(1, { operation: "mark_processed", "event.type": outbox.eventType });
			return "lock_miss";
		}

		recordsProcessed.add(1, { "event.type": outbox.eventType });
		return "published";
	}

	private async markAsDead(outbox: OutboxRecord): Promise<boolean> {
		const marked = await this.outboxRepository.markAsDead({
			id: outbox.id as string,
			attempts: outbox.attempts,
			retry: (e, attempts) => {
				this.logger.error({
					message: `Error marking outbox record ${outbox.id} as dead`,
					extra: { recordId: outbox.id, attempts },
					error: e,
				});
				return true;
			},
		});

		if (!marked) {
			this.logger.warn({
				message: `Outbox record ${outbox.id} was not marked as DEAD: optimistic-lock miss (record changed concurrently)`,
				extra: { recordId: outbox.id, attempts: outbox.attempts },
			});
			optimisticLockMisses.add(1, { operation: "mark_dead", "event.type": outbox.eventType });
			return false;
		}

		this.logger.warn({
			message: `Outbox record ${outbox.id} reached max attempts, marked as DEAD`,
			extra: { recordId: outbox.id, attempts: outbox.attempts, maxAttempts: this.maxAttempts },
		});
		recordsDead.add(1, { reason: "max_attempts_exceeded", "event.type": outbox.eventType });
		return true;
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

			this.logger.debug({
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
