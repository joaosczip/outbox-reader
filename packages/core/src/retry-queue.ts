import type { Logger } from "./logger";
import { recordsFailed, retryAttempts, retryQueueSize } from "./metrics";
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
				recordsFailed.add(1, { "event.type": record.eventType });
				this.deps.logger.error({
					message: `Outbox record ${record.id} exhausted all ${this.deps.config.numOfAttempts} retry attempts`,
					extra: { recordId: record.id },
					error,
				});
				await this.deps.outboxRepository.markAsFailed({
					id: record.id as string,
					attempts: record.attempts,
					retry: (e: Error, attempts: number) => {
						this.deps.logger.error({
							message: `Error marking outbox record ${record.id} as failed`,
							extra: { recordId: record.id, attempts },
							error: e,
						});
						return true;
					},
				});
			} else {
				this.deps.logger.warn({
					message: `Outbox record ${record.id} failed, scheduling retry attempt ${nextAttempt + 1}`,
					extra: { recordId: record.id, nextAttempt },
				});
				this.schedule({ record, attempt: nextAttempt });
			}
		}
	}

	private computeDelay(attempt: number): number {
		const { startingDelayInMs = 500, maxDelayInMs, jitter } = this.deps.config;
		const exp = Math.min(startingDelayInMs * 2 ** attempt, maxDelayInMs);
		return jitter === "full" ? Math.random() * exp : exp;
	}
}
