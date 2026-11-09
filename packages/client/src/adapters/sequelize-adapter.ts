import type { OutboxAdapter } from "../types/adapter";
import type { OutboxTableOptions } from "../types/adapter-options";
import type { CreateOutboxEvent } from "../types/outbox-event";
import type { Transaction } from "../types/transaction";
import { buildInsertStatement, buildInsertValues } from "../utils/insert-statement";
import { uuidv7 } from "../utils/uuid-v7";

export type SequelizeTransaction = {
	LOCK?: unknown;
};

export type SequelizeLike = {
	query(sql: string, options?: Record<string, unknown>): Promise<unknown>;
};

export type SequelizeAdapterOptions = OutboxTableOptions;

export class SequelizeAdapter implements OutboxAdapter<SequelizeTransaction> {
	private readonly insertSql: string;

	constructor(
		private readonly sequelize: SequelizeLike,
		options: SequelizeAdapterOptions = {},
	) {
		this.insertSql = buildInsertStatement(options);
	}

	async create(event: CreateOutboxEvent, transaction: Transaction<SequelizeTransaction>): Promise<string> {
		const id = uuidv7();
		await this.sequelize.query(this.insertSql, {
			bind: buildInsertValues(id, event),
			transaction: transaction.underlying,
		});
		return id;
	}
}
