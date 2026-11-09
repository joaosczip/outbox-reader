export type CreateOutboxEvent = {
	/**
	 * Optional record id (a UUID, the outbox `id` column type). Pass a deterministic
	 * id for producer-side idempotency: core publishes it as the NATS dedup msgID,
	 * and inserting the same id twice fails on the primary key. Omit it to get a
	 * generated UUIDv7.
	 */
	id?: string;
	/** Id of the affected domain entity. Non-empty. Events of one aggregate are published in order. */
	aggregateId: string;
	/** Domain entity name, e.g. `"Order"`. Non-empty. */
	aggregateType: string;
	/** Event name, used by core as the NATS subject, e.g. `"order.created"`. Non-empty. */
	eventType: string;
	/** JSON-serialisable event data (stored as JSONB). Use `null` for no data. */
	payload: unknown;
};
