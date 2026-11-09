import type { OutboxAdapter } from "./types/adapter";
import type { CreateOutboxEvent } from "./types/outbox-event";
import type { TransactionInput } from "./types/transaction";
import { toTransaction, validateOutboxEvent } from "./utils/validation";

export class OutboxClient<TTransaction = unknown> {
	private readonly adapter: OutboxAdapter<TTransaction>;

	constructor(adapter: OutboxAdapter<TTransaction>) {
		this.adapter = adapter;
	}

	/**
	 * Writes the event to the outbox table inside `transaction` and returns its id.
	 *
	 * @param transaction the ORM transaction (`tx`) or an explicit `{ underlying: tx }` wrapper.
	 *   Adapters always receive the wrapper form.
	 */
	async create(event: CreateOutboxEvent, transaction: TransactionInput<TTransaction>): Promise<string> {
		const wrapped = toTransaction(transaction);
		validateOutboxEvent(event);
		return this.adapter.create(event, wrapped);
	}
}
