import type { CreateOutboxEvent } from "../types/outbox-event";
import type { Transaction, TransactionInput } from "../types/transaction";
import { uuidv7 } from "./uuid-v7";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const show = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : String(value));

function assertNonEmptyString(event: CreateOutboxEvent, field: "aggregateId" | "aggregateType" | "eventType"): void {
	const value = event[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new TypeError(`CreateOutboxEvent.${field} must be a non-empty string (got ${show(value)})`);
	}
}

/** Throws a descriptive error when the event cannot be written to the outbox table. */
export function validateOutboxEvent(event: CreateOutboxEvent): void {
	if (typeof event !== "object" || event === null) {
		throw new TypeError(`Outbox event must be an object (got ${show(event)})`);
	}
	assertNonEmptyString(event, "aggregateId");
	assertNonEmptyString(event, "aggregateType");
	assertNonEmptyString(event, "eventType");

	const { payload } = event;
	if (payload === undefined || typeof payload === "function" || typeof payload === "symbol") {
		throw new TypeError(
			`CreateOutboxEvent.payload is required and must be JSON-serialisable (got ${typeof payload}); use null for an empty payload`,
		);
	}

	if (event.id !== undefined && (typeof event.id !== "string" || !UUID.test(event.id))) {
		throw new TypeError(`CreateOutboxEvent.id must be a UUID string when provided (got ${show(event.id)})`);
	}
}

/** Validates the event and returns the id to insert: the caller's `id`, or a new UUIDv7. */
export function resolveOutboxEventId(event: CreateOutboxEvent): string {
	validateOutboxEvent(event);
	return event.id ?? uuidv7();
}

const isTransactionWrapper = <T>(value: TransactionInput<T>): value is Transaction<T> =>
	typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "underlying");

/**
 * Normalises a raw ORM transaction or a `{ underlying }` wrapper into a wrapper.
 * A value is treated as the wrapper only when it has an OWN `underlying` property.
 */
export function toTransaction<T>(input: TransactionInput<T>): Transaction<T> {
	const transaction = isTransactionWrapper(input) ? input : { underlying: input as T };
	if (transaction.underlying === undefined || transaction.underlying === null) {
		throw new TypeError(
			"An outbox transaction is required: pass your ORM transaction (or { underlying: tx }) so the event is written atomically with your domain changes",
		);
	}
	return transaction;
}
