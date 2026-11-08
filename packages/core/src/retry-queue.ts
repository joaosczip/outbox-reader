import type { Logger } from "./logger";
import { optimisticLockMisses, recordsDead, recordsFailed, retryAttempts, retryQueueSize } from "./metrics";
import type { OutboxRecord } from "./models/outbox-record";
import type { OutboxProcessor } from "./outbox-processor";
import type { OutboxRepository } from "./outbox-repository";
import type { Publisher, RetryConfig } from "./types";

type QueueEntry = {
	record: OutboxRecord;
	attempt: number; // 0-indexed; max = config.numOfAttempts - 1
};

export class RetryQueue {
	private stopped = false;
	private pendingTimers: ReturnType<typeof setTimeout>[] = [];

	constructor(
		private readonly deps: {
			processor: OutboxProcessor;
			publisher: Publisher;
			outboxRepository: OutboxRepository;
			logger: Logger;
			config: RetryConfig;
			/** Records whose attempts reach this value after the final retry are marked DEAD. */
			maxAttempts: number;
		},
	) {}

	enqueue(record: OutboxRecord): void {
		retryQueueSize.add(1);
		this.schedule({ record, attempt: 0 });
	}

	stop(): void {
		this.stopped = true;
		for (const t of this.pendingTimers) clearTimeout(t);
		this.pendingTimers = [];
	}

	private schedule(entry: QueueEntry): void {
		const delay = this.computeDelay(entry.attempt);
		const timer = setTimeout(() => {
			this.pendingTimers = this.pendingTimers.filter((t) => t !== timer);
			if (!this.stopped) this.run(entry);
		}, delay);
		this.pendingTimers.push(timer);
	}

	private async run(entry: QueueEntry): Promise<void> {
		const { record, attempt } = entry;
		retryAttempts.add(1, { "event.type": record.eventType });
		try {
			await this.deps.processor.processInserts({
				insertedRecord: record,
				publisher: this.deps.publisher,
				prefetchedOutbox: undefined, // force fresh DB read on every retry
			});
			retryQueueSize.add(-1);
			this.deps.logger.info({
				message: `Outbox record ${record.id} succeeded on retry attempt ${attempt + 1}`,
				extra: { recordId: record.id, attempt: attempt + 1 },
			});
		} catch (error) {
			const nextAttempt = attempt + 1;
			if (nextAttempt >= this.deps.config.numOfAttempts) {
				retryQueueSize.add(-1);
				this.deps.logger.error({
					message: `Outbox record ${record.id} exhausted all ${this.deps.config.numOfAttempts} retry attempts`,
					extra: { recordId: record.id },
					error,
				});
				await this.markExhausted(record);
			} else {
				this.deps.logger.warn({
					message: `Outbox record ${record.id} failed, scheduling retry attempt ${nextAttempt + 1}`,
					extra: { recordId: record.id, nextAttempt },
				});
				this.schedule({ record, attempt: nextAttempt });
			}
		}
	}

	/** Marks an exhausted record FAILED, or DEAD when this failure consumes its last allowed attempt. */
	private async markExhausted(record: OutboxRecord): Promise<void> {
		const isDead = record.attempts + 1 >= this.deps.maxAttempts;
		const status = isDead ? "DEAD" : "FAILED";
		const retry = (e: Error, attempts: number) => {
			this.deps.logger.error({
				message: `Error marking outbox record ${record.id} as ${status.toLowerCase()}`,
				extra: { recordId: record.id, attempts },
				error: e,
			});
			return true;
		};
		const id = record.id as string;

		const marked = isDead
			? await this.deps.outboxRepository.markAsDead({ id, attempts: record.attempts, retry, countAttempt: true })
			: await this.deps.outboxRepository.markAsFailed({ id, attempts: record.attempts, retry });

		if (!marked) {
			this.deps.logger.warn({
				message: `Outbox record ${record.id} was not marked as ${status}: optimistic-lock miss (record changed concurrently)`,
				extra: { recordId: record.id, attempts: record.attempts },
			});
			optimisticLockMisses.add(1, {
				operation: isDead ? "mark_dead" : "mark_failed",
				"event.type": record.eventType,
			});
			return;
		}

		if (isDead) {
			this.deps.logger.warn({
				message: `Outbox record ${record.id} reached max attempts, marked as DEAD`,
				extra: { recordId: record.id, attempts: record.attempts + 1, maxAttempts: this.deps.maxAttempts },
			});
			recordsDead.add(1, { reason: "retries_exhausted", "event.type": record.eventType });
		} else {
			recordsFailed.add(1, { "event.type": record.eventType });
		}
	}

	private computeDelay(attempt: number): number {
		const { startingDelayInMs = 500, maxDelayInMs, jitter } = this.deps.config;
		const exp = Math.min(startingDelayInMs * 2 ** attempt, maxDelayInMs);
		return jitter === "full" ? Math.random() * exp : exp;
	}
}
