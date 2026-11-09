import { describe, expect, it } from "bun:test";
import { uuidv7 } from "../../src/utils/uuid-v7";
import { UUID_V7 } from "../mocks/orm";

/** Extracts the 48-bit unix-ms timestamp from the first 12 hex digits. */
const timestampOf = (uuid: string): number => Number.parseInt(uuid.replace(/-/g, "").slice(0, 12), 16);

describe("uuidv7", () => {
	it("returns a canonical lowercase RFC 9562 version 7 / variant 10 uuid", () => {
		const id = uuidv7();

		expect(id).toMatch(UUID_V7);
		expect(id[14]).toBe("7");
		expect(["8", "9", "a", "b"]).toContain(id[19]);
	});

	it("encodes the given unix-ms timestamp in the first 48 bits", () => {
		const ms = 1_700_000_000_123;

		const id = uuidv7(ms);

		expect(timestampOf(id)).toBe(ms);
		expect(id.slice(0, 13)).toBe("018bcfe5-687b");
	});

	it("encodes the current time by default", () => {
		const before = Date.now();
		const id = uuidv7();
		const after = Date.now();

		expect(timestampOf(id)).toBeGreaterThanOrEqual(before);
		expect(timestampOf(id)).toBeLessThanOrEqual(after);
	});

	it("handles the timestamp range edges", () => {
		expect(uuidv7(0).slice(0, 13)).toBe("00000000-0000");
		expect(uuidv7(2 ** 48 - 1).slice(0, 13)).toBe("ffffffff-ffff");
	});

	it("rejects timestamps outside the 48-bit range", () => {
		expect(() => uuidv7(-1)).toThrow(/timestamp/);
		expect(() => uuidv7(2 ** 48)).toThrow(/timestamp/);
		expect(() => uuidv7(1.5)).toThrow(/timestamp/);
	});

	it("sorts lexicographically by creation time across milliseconds", () => {
		const ids = [uuidv7(1_000), uuidv7(1_001), uuidv7(5_000_000), uuidv7(1_700_000_000_000)];

		expect([...ids].sort()).toEqual(ids);
	});

	it("produces unique values within the same millisecond", () => {
		const ms = Date.now();
		const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(ms)));

		expect(ids.size).toBe(1000);
	});

	it("does not rely on the Bun global", () => {
		const bun = globalThis.Bun as unknown as Record<string, unknown>;
		const original = bun.randomUUIDv7;
		bun.randomUUIDv7 = () => {
			throw new Error("Bun is not defined");
		};
		try {
			expect(uuidv7()).toMatch(UUID_V7);
		} finally {
			bun.randomUUIDv7 = original;
		}
	});
});
