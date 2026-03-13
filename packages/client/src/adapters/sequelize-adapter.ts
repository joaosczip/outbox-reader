import { OutboxStatus } from "../models/outbox-status";
import type { OutboxAdapter } from "../types/adapter";
import type { CreateOutboxEvent } from "../types/outbox-event";
import type { Transaction } from "../types/transaction";

export type SequelizeTransaction = {
	LOCK?: unknown;
};

export type SequelizeLike = {
	query(sql: string, options?: Record<string, unknown>): Promise<unknown>;
};

export class SequelizeAdapter implements OutboxAdapter<SequelizeTransaction> {
	constructor(private readonly sequelize: SequelizeLike) {}

	async create(event: CreateOutboxEvent, transaction: Transaction<SequelizeTransaction>): Promise<string> {
		const id = Bun.randomUUIDv7();
		await this.sequelize.query(
			`INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload, status, attempts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
			{
				bind: [
					id,
					event.aggregateId,
					event.aggregateType,
					event.eventType,
					JSON.stringify(event.payload),
					OutboxStatus.PENDING,
					0,
				],
				transaction: transaction.underlying,
			},
		);
		return id;
	}
}
