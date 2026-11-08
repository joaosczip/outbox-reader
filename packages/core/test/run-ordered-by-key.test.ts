import { beforeEach, describe, expect, it } from "bun:test";
import { runOrderedByKey } from "../src/utils/run-ordered-by-key";

interface Item {
	id: string;
	key: string;
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
}

const createDeferred = (): Deferred => {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

/** Lets pending microtasks / promise chains settle. */
const flush = async (rounds = 10) => {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
	}
};

const keyOf = (item: Item) => item.key;

describe("runOrderedByKey", () => {
	let deferreds: Map<string, Deferred>;
	let events: string[];
	let inFlight: number;
	let maxInFlight: number;
	let worker: (item: Item) => Promise<void>;

	beforeEach(() => {
		deferreds = new Map();
		events = [];
		inFlight = 0;
		maxInFlight = 0;
		worker = async (item: Item) => {
			events.push(`start:${item.id}`);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const deferred = createDeferred();
			deferreds.set(item.id, deferred);
			try {
				await deferred.promise;
			} finally {
				inFlight--;
				events.push(`end:${item.id}`);
			}
		};
	});

	it("resolves immediately for empty input without calling the worker", async () => {
		let calls = 0;
		await expect(
			runOrderedByKey<Item>(
				[],
				keyOf,
				async () => {
					calls++;
				},
				{ concurrency: 2 },
			),
		).resolves.toBeUndefined();
		expect(calls).toBe(0);
	});

	it.each([0, -1, 1.5, Number.NaN])("rejects with RangeError for invalid concurrency %p", async (concurrency) => {
		let calls = 0;
		await expect(
			runOrderedByKey(
				[{ id: "a1", key: "a" }],
				keyOf,
				async () => {
					calls++;
				},
				{ concurrency },
			),
		).rejects.toBeInstanceOf(RangeError);
		expect(calls).toBe(0);
	});

	it("runs same-key items sequentially in input order even when the first one is slower", async () => {
		const items: Item[] = [
			{ id: "a1", key: "a" },
			{ id: "a2", key: "a" },
			{ id: "a3", key: "a" },
		];
		const run = runOrderedByKey(items, keyOf, worker, { concurrency: 4 });

		await flush();
		// Only the first item of the key has started; the others wait for it.
		expect(events).toEqual(["start:a1"]);

		// a1 is "slow": nothing else of key "a" starts until it finishes.
		await flush();
		expect(events).toEqual(["start:a1"]);

		deferreds.get("a1")?.resolve();
		await flush();
		expect(events).toEqual(["start:a1", "end:a1", "start:a2"]);

		deferreds.get("a2")?.resolve();
		await flush();
		deferreds.get("a3")?.resolve();
		await run;

		expect(events).toEqual(["start:a1", "end:a1", "start:a2", "end:a2", "start:a3", "end:a3"]);
		expect(maxInFlight).toBe(1);
	});

	it("preserves per-key order for interleaved keys", async () => {
		const items: Item[] = [
			{ id: "a1", key: "a" },
			{ id: "b1", key: "b" },
			{ id: "a2", key: "a" },
			{ id: "b2", key: "b" },
		];
		const run = runOrderedByKey(items, keyOf, worker, { concurrency: 2 });

		await flush();
		expect(events).toEqual(["start:a1", "start:b1"]);

		// Finish b1 first: b2 starts, a2 still waits on a1.
		deferreds.get("b1")?.resolve();
		await flush();
		expect(events).toEqual(["start:a1", "start:b1", "end:b1", "start:b2"]);
		expect(events).not.toContain("start:a2");

		deferreds.get("a1")?.resolve();
		await flush();
		expect(events.indexOf("start:a2")).toBeGreaterThan(events.indexOf("end:a1"));

		deferreds.get("a2")?.resolve();
		deferreds.get("b2")?.resolve();
		await run;

		const order = (key: string) => events.filter((e) => e.startsWith(`start:${key}`));
		expect(order("a")).toEqual(["start:a1", "start:a2"]);
		expect(order("b")).toEqual(["start:b1", "start:b2"]);
	});

	it("runs different keys in parallel (overlapping in time)", async () => {
		const items: Item[] = [
			{ id: "a1", key: "a" },
			{ id: "b1", key: "b" },
			{ id: "c1", key: "c" },
		];
		const run = runOrderedByKey(items, keyOf, worker, { concurrency: 3 });

		await flush();
		// All three started before any of them ended.
		expect(events).toEqual(["start:a1", "start:b1", "start:c1"]);
		expect(inFlight).toBe(3);

		for (const id of ["c1", "a1", "b1"]) deferreds.get(id)?.resolve();
		await run;

		expect(maxInFlight).toBe(3);
		expect(inFlight).toBe(0);
	});

	it("never exceeds the concurrency limit of keys in flight", async () => {
		const items: Item[] = ["a", "b", "c", "d", "e"].flatMap((key) => [
			{ id: `${key}1`, key },
			{ id: `${key}2`, key },
		]);
		const run = runOrderedByKey(items, keyOf, worker, { concurrency: 2 });

		await flush();
		expect(events).toEqual(["start:a1", "start:b1"]);
		expect(inFlight).toBe(2);

		// Drive to completion, resolving whatever is currently in flight.
		let resolvedCount = 0;
		while (resolvedCount < items.length) {
			const started = events.filter((e) => e.startsWith("start:")).map((e) => e.slice(6));
			const ended = new Set(events.filter((e) => e.startsWith("end:")).map((e) => e.slice(4)));
			const pending = started.filter((id) => !ended.has(id));
			expect(pending.length).toBeGreaterThan(0);
			expect(pending.length).toBeLessThanOrEqual(2);
			deferreds.get(pending[0])?.resolve();
			resolvedCount++;
			await flush();
		}
		await run;

		expect(maxInFlight).toBe(2);
		expect(events.filter((e) => e.startsWith("start:"))).toHaveLength(items.length);
		for (const key of ["a", "b", "c", "d", "e"]) {
			expect(events.indexOf(`start:${key}2`)).toBeGreaterThan(events.indexOf(`end:${key}1`));
		}
	});

	it("keeps running later same-key items and other keys after a failure, then rejects with AggregateError", async () => {
		const items: Item[] = [
			{ id: "a1", key: "a" },
			{ id: "b1", key: "b" },
			{ id: "a2", key: "a" },
			{ id: "b2", key: "b" },
		];
		const boomA1 = new Error("a1 failed");
		const boomB2 = new Error("b2 failed");
		const run = runOrderedByKey(items, keyOf, worker, { concurrency: 2 });
		let settled = false;
		const outcome = run.then(
			() => {
				settled = true;
				return undefined;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);

		await flush();
		deferreds.get("a1")?.reject(boomA1);
		await flush();
		// a2 still runs after a1 failed; key b is unaffected.
		expect(events).toContain("start:a2");
		expect(settled).toBe(false);

		deferreds.get("b1")?.resolve();
		await flush();
		expect(events).toContain("start:b2");

		deferreds.get("a2")?.resolve();
		deferreds.get("b2")?.reject(boomB2);

		const error = await outcome;
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([boomA1, boomB2]);
		expect(events.filter((e) => e.startsWith("end:")).sort()).toEqual(["end:a1", "end:a2", "end:b1", "end:b2"]);
	});

	it("collects synchronous throws from the worker as well", async () => {
		const boom = new Error("sync");
		const seen: string[] = [];
		const syncWorker = ((item: Item) => {
			seen.push(item.id);
			if (item.id === "a1") throw boom;
			return Promise.resolve();
		}) as (item: Item) => Promise<void>;

		const error = await runOrderedByKey(
			[
				{ id: "a1", key: "a" },
				{ id: "a2", key: "a" },
			],
			keyOf,
			syncWorker,
			{ concurrency: 1 },
		).catch((e: unknown) => e);

		expect(seen).toEqual(["a1", "a2"]);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([boom]);
	});

	it("resolves when every worker succeeds", async () => {
		const seen: string[] = [];
		await expect(
			runOrderedByKey(
				[
					{ id: "a1", key: "a" },
					{ id: "b1", key: "b" },
				],
				keyOf,
				async (item) => {
					seen.push(item.id);
				},
				{ concurrency: 1 },
			),
		).resolves.toBeUndefined();
		expect(seen).toEqual(["a1", "b1"]);
	});
});
