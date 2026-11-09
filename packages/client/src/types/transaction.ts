/** Explicit wrapper around an ORM transaction. */
export interface Transaction<T = unknown> {
	readonly underlying: T;
}

/**
 * What `OutboxClient.create()` accepts: either the ORM transaction itself
 * (`outbox.create(event, tx)`) or the explicit `{ underlying: tx }` wrapper.
 */
export type TransactionInput<T = unknown> = T | Transaction<T>;
