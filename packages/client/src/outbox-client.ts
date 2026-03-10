import type { OutboxAdapter } from "./types/adapter";
import type { CreateOutboxEvent } from "./types/outbox-event";
import type { Transaction } from "./types/transaction";

export class OutboxClient<TTransaction = unknown> {
	private readonly adapter: OutboxAdapter<TTransaction>;

	constructor(adapter: OutboxAdapter<TTransaction>) {
		this.adapter = adapter;
	}

	async create(event: CreateOutboxEvent, transaction: Transaction<TTransaction>): Promise<string> {
		return this.adapter.create(event, transaction);
	}
}
