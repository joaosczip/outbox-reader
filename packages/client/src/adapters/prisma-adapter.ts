import type { OutboxAdapter } from "../types/adapter";
import type { OutboxTableOptions } from "../types/adapter-options";
import type { CreateOutboxEvent } from "../types/outbox-event";
import type { Transaction } from "../types/transaction";
import { buildInsertStatement, buildInsertValues } from "../utils/insert-statement";
import { uuidv7 } from "../utils/uuid-v7";

export type PrismaTransactionClient = {
	$executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

export type PrismaAdapterOptions = OutboxTableOptions;

export class PrismaAdapter implements OutboxAdapter<PrismaTransactionClient> {
	private readonly insertSql: string;

	constructor(options: PrismaAdapterOptions = {}) {
		this.insertSql = buildInsertStatement(options);
	}

	async create(event: CreateOutboxEvent, transaction: Transaction<PrismaTransactionClient>): Promise<string> {
		const id = uuidv7();
		await transaction.underlying.$executeRawUnsafe(this.insertSql, ...buildInsertValues(id, event));
		return id;
	}
}
