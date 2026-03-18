import type { Logger } from "./logger";
import type { OutboxRecord } from "./models/outbox-record";
import type { OutboxRepository } from "./outbox-repository";
import type { Publisher, RetryConfig } from "./types";

type ProcessorLike = {
	processInserts: (params: {
		insertedRecord: OutboxRecord;
		publisher: Publisher;
		prefetchedOutbox?: OutboxRecord | null;
	}) => Promise<void>;
};

type QueueEntry = {
	record: OutboxRecord;
	attempt: number; // 0-indexed; max = config.numOfAttempts - 1
};

export class RetryQueue {
	private stopped = false;
	private pendingTimers: ReturnType<typeof setTimeout>[] = [];

	constructor(
		private readonly deps: {
			processor: ProcessorLike;
			publisher: Publisher;
			outboxRepository: OutboxRepository;
			logger: Logger;
			config: RetryConfig;
		},
	) {}

	enqueue(record: OutboxRecord): void {
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
		try {
			await this.deps.processor.processInserts({
				insertedRecord: record,
				publisher: this.deps.publisher,
				prefetchedOutbox: undefined, // force fresh DB read on every retry
			});
			this.deps.logger.info({
				message: `Outbox record ${record.id} succeeded on retry attempt ${attempt + 1}`,
				extra: { recordId: record.id, attempt: attempt + 1 },
			});
		} catch (error) {
			const nextAttempt = attempt + 1;
			if (nextAttempt >= this.deps.config.numOfAttempts) {
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
					error,
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
