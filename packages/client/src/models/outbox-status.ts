export enum OutboxStatus {
	PENDING = "PENDING",
	PROCESSED = "PROCESSED",
	FAILED = "FAILED",
	/** Terminal: max attempts reached; the record is no longer retried or reprocessed. */
	DEAD = "DEAD",
}
