import { randomUUID } from "node:crypto";
import { OutboxStatus } from "../models/outbox-status";
import type { OutboxAdapter } from "../types/adapter";
import type { CreateOutboxEvent } from "../types/outbox-event";
import type { Transaction } from "../types/transaction";

export type PrismaTransactionClient = {
	$executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

export class PrismaAdapter implements OutboxAdapter<PrismaTransactionClient> {
	async create(event: CreateOutboxEvent, transaction: Transaction<PrismaTransactionClient>): Promise<string> {
		const id = randomUUID();
		await transaction.underlying.$executeRawUnsafe(
			`INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload, status, attempts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
			id,
			event.aggregateId,
			event.aggregateType,
			event.eventType,
			JSON.stringify(event.payload),
			OutboxStatus.PENDING,
			0,
		);
		return id;
	}
}
