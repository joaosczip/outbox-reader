import type { Logger } from "./logger";
import { optimisticLockMisses, recordsDead, recordsFailed, retryAttempts, retryQueueSize } from "./metrics";
import type { OutboxRecord } from "./models/outbox-record";
import type { OutboxProcessor } from "./outbox-processor";
import type { OutboxRepository } from "./outbox-repository";
import { drainReadySuccessors } from "./successor-drain";
import type { Publisher, RetryConfig } from "./types";
import { AggregateSequencer } from "./utils/aggregate-sequencer";

type QueueEntry = {
	record: OutboxRecord;
	attempt: number; // 0-indexed; max = config.numOfAttempts - 1
};

/** Default maximum number of retries running at once when no `concurrency` is given. */
export const DEFAULT_RETRY_CONCURRENCY = 10;

export type RetryQueueStats = {
	/** Retries waiting on their backoff timer. */
	scheduled: number;
	/** Retries whose delay elapsed, waiting for a free concurrency slot (FIFO). */
	queued: number;
	/** Retries currently running `processor.processInserts`. */
	inFlight: number;
};

export class RetryQueue {
	private stopped = false;
	private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
	/** FIFO of due retries; `readyHead` is the index of the next entry to start (O(1) dequeue). */
	private ready: QueueEntry[] = [];
	private readyHead = 0;
	private inFlight = 0;
	private readonly concurrency: number;
	private readonly sequencer: AggregateSequencer;

	constructor(
		private readonly deps: {
			processor: OutboxProcessor;
			publisher: Publisher;
			outboxRepository: OutboxRepository;
			logger: Logger;
			config: RetryConfig;
			/** Records whose attempts reach this value after the final retry are marked DEAD. */
			maxAttempts: number;
			/**
			 * Maximum number of retries running at once (each one does a SELECT + publish + UPDATE and
			 * competes with the WAL flow for the pg pool). Due retries beyond it wait in a FIFO.
			 * Integer >= 1, default {@link DEFAULT_RETRY_CONCURRENCY}.
			 */
			concurrency?: number;
			/**
			 * Shared with the WAL handler so the two paths never publish one aggregate at the same
			 * time. A private chain is used when omitted.
			 */
			sequencer?: AggregateSequencer;
		},
	) {
		const concurrency = deps.concurrency ?? DEFAULT_RETRY_CONCURRENCY;
		if (!Number.isInteger(concurrency) || concurrency < 1) {
			throw new RangeError(`RetryQueue concurrency must be an integer >= 1, received ${concurrency}`);
		}
		this.concurrency = concurrency;
		this.sequencer = deps.sequencer ?? new AggregateSequencer();
	}

	enqueue(record: OutboxRecord): void {
		if (this.stopped) {
			this.deps.logger.warn({
				message: `Outbox record ${record.id} not enqueued for retry: retry queue is stopped`,
				extra: { recordId: record.id },
			});
			return;
		}
		retryQueueSize.add(1);
		this.schedule({ record, attempt: 0 });
	}

	/** Cancels pending timers and discards due-but-not-started retries. In-flight retries finish but are not rescheduled. */
	stop(): void {
		this.stopped = true;
		const discarded = this.pendingTimers.size + (this.ready.length - this.readyHead);
		for (const t of this.pendingTimers) clearTimeout(t);
		this.pendingTimers.clear();
		this.ready = [];
		this.readyHead = 0;
		if (discarded > 0) retryQueueSize.add(-discarded);
	}

	stats(): RetryQueueStats {
		return {
			scheduled: this.pendingTimers.size,
			queued: this.ready.length - this.readyHead,
			inFlight: this.inFlight,
		};
	}

	private schedule(entry: QueueEntry): void {
		if (this.stopped) {
			retryQueueSize.add(-1);
			return;
		}
		const delay = this.computeDelay(entry.attempt);
		// Leave the aggregate turn before arming the timer. AsyncLocalStorage would otherwise
		// stick to the callback and the next attempt would look like sequencer re-entry.
		const timer = this.sequencer.exit(() =>
			setTimeout(() => {
				this.pendingTimers.delete(timer);
				if (this.stopped) return;
				this.ready.push(entry);
				this.drain();
			}, delay),
		);
		this.pendingTimers.add(timer);
	}

	/** Starts due retries while concurrency slots are free. */
	private drain(): void {
		while (!this.stopped && this.inFlight < this.concurrency && this.readyHead < this.ready.length) {
			const entry = this.ready[this.readyHead] as QueueEntry;
			this.readyHead++;
			if (this.readyHead === this.ready.length) {
				this.ready = [];
				this.readyHead = 0;
			} else if (this.readyHead > 1024 && this.readyHead * 2 > this.ready.length) {
				this.ready = this.ready.slice(this.readyHead);
				this.readyHead = 0;
			}
			this.inFlight++;
			void this.run(entry).finally(() => {
				this.inFlight--;
				this.drain();
			});
		}
	}

	private async run(entry: QueueEntry): Promise<void> {
		await this.sequencer.run(entry.record.aggregateId, () => this.attempt(entry));
	}

	private async attempt(entry: QueueEntry): Promise<void> {
		const { record, attempt } = entry;
		retryAttempts.add(1, { "event.type": record.eventType });
		try {
			const outcome = await this.deps.processor.processInserts({
				insertedRecord: record,
				publisher: this.deps.publisher,
				prefetchedOutbox: undefined, // force fresh DB read on every retry
			});
			retryQueueSize.add(-1);
			if (outcome === "blocked") return;
			if (outcome !== "dead") {
				this.deps.logger.info({
					message: `Outbox record ${record.id} succeeded on retry attempt ${attempt + 1}`,
					extra: { recordId: record.id, attempt: attempt + 1 },
				});
			}
			if (outcome === "published" || outcome === "dead") {
				await this.drainSuccessors(record.aggregateId);
			}
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
			// DEAD does not block the tail. Drain runs in this same sequencer turn.
			await this.drainSuccessors(record.aggregateId);
		} else {
			recordsFailed.add(1, { "event.type": record.eventType });
		}
	}

	private drainSuccessors(aggregateId: string): Promise<void> {
		return drainReadySuccessors({
			aggregateId,
			processor: this.deps.processor,
			repository: this.deps.outboxRepository,
			publisher: this.deps.publisher,
			retryQueue: this,
			logger: this.deps.logger,
		});
	}

	private computeDelay(attempt: number): number {
		const { startingDelayInMs = 500, maxDelayInMs, jitter } = this.deps.config;
		const exp = Math.min(startingDelayInMs * 2 ** attempt, maxDelayInMs);
		return jitter === "full" ? Math.random() * exp : exp;
	}
}
