import type { CreateOutboxEvent } from "./outbox-event";
import type { Transaction } from "./transaction";

export interface OutboxAdapter<TTransaction = unknown> {
	create(event: CreateOutboxEvent, transaction: Transaction<TTransaction>): Promise<string>;
}
