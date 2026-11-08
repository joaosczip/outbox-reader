import pAll from "p-all";

export interface RunOrderedByKeyOptions {
	/** Maximum number of distinct keys processed in parallel. Must be an integer >= 1. */
	concurrency: number;
}

/**
 * Runs `worker` for every item, guaranteeing that items sharing the same key
 * (as returned by `keyOf`) are processed strictly sequentially, in input order,
 * while different keys are processed in parallel with at most
 * `options.concurrency` keys in flight at any time.
 *
 * Error semantics:
 * - A rejection from `worker` never stops other keys from being processed.
 * - Within a key, the remaining items still run after a previous item rejected.
 * - Once every item has been attempted, if any worker call rejected (or threw
 *   synchronously), the returned promise rejects with an `AggregateError` whose
 *   `errors` array contains every error, in the order they occurred. Otherwise
 *   it resolves.
 * - If `keyOf` throws, the promise rejects with that error before any worker runs.
 *
 * Empty input resolves immediately. Rejects with a `RangeError` if
 * `concurrency` is not an integer >= 1.
 */
export async function runOrderedByKey<T>(
	items: T[],
	keyOf: (item: T) => string,
	worker: (item: T) => Promise<void>,
	options: RunOrderedByKeyOptions,
): Promise<void> {
	const { concurrency } = options;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new RangeError(`concurrency must be an integer >= 1, received ${concurrency}`);
	}

	if (items.length === 0) {
		return;
	}

	// Map preserves insertion order, so keys are started in order of first appearance.
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key);
		if (group) {
			group.push(item);
		} else {
			groups.set(key, [item]);
		}
	}

	const errors: unknown[] = [];

	await pAll(
		Array.from(groups.values(), (group) => async () => {
			for (const item of group) {
				try {
					await worker(item);
				} catch (error) {
					errors.push(error);
				}
			}
		}),
		{ concurrency },
	);

	if (errors.length > 0) {
		throw new AggregateError(errors, `${errors.length} of ${items.length} item(s) failed in runOrderedByKey`);
	}
}
