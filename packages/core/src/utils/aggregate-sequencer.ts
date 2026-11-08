import { AsyncLocalStorage } from "node:async_hooks";

const runningAggregate = new AsyncLocalStorage<string>();

/**
 * Per-aggregate promise chain shared by WAL handling and the RetryQueue.
 *
 * Tasks for one aggregate run one at a time, in the order `run` was called.
 * Different aggregates run concurrently and are not capped here (callers keep
 * their own concurrency limits).
 *
 * Do not call `run` for an aggregate from inside a task that is already running
 * for that same aggregate. The nested call throws instead of waiting: the outer
 * task would be waiting for a chain that is waiting for the outer task. Drain
 * successors in the same turn; do not re-enter the chain to do it.
 */
export class AggregateSequencer {
	private tails = new Map<string, Promise<void>>();

	/**
	 * Runs `fn` outside any aggregate turn. Timers created here are not bound to the
	 * current turn, so a retry scheduled from inside a task does not look like re-entry
	 * when it later fires.
	 */
	exit<T>(fn: () => T): T {
		return runningAggregate.exit(fn);
	}

	run<T>(aggregateId: string, task: () => Promise<T>): Promise<T> {
		if (runningAggregate.getStore() === aggregateId) {
			throw new Error(
				`AggregateSequencer cannot be re-entered for aggregate ${aggregateId} from inside a running task`,
			);
		}

		const prev = this.tails.get(aggregateId) ?? Promise.resolve();
		const result = prev.then(() => runningAggregate.run(aggregateId, task));
		// The tail must stay fulfilled so a rejected task does not wedge the aggregate.
		const settled: Promise<void> = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(aggregateId, settled);
		void settled.finally(() => {
			if (this.tails.get(aggregateId) === settled) this.tails.delete(aggregateId);
		});
		return result;
	}
}
