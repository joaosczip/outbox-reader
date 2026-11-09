import { randomBytes } from "node:crypto";

const MAX_TIMESTAMP_MS = 2 ** 48 - 1;

/**
 * Generates an RFC 9562 UUID version 7 using only `node:crypto`, so it runs on
 * Node.js and Bun alike.
 *
 * Layout: 48-bit big-endian unix timestamp in milliseconds, 4-bit version (`7`),
 * 12 random bits, 2-bit variant (`10`), 62 random bits. Ids created in later
 * milliseconds sort after earlier ones; ids within the same millisecond are
 * unique but not ordered.
 *
 * @param timestampMs unix time in milliseconds (defaults to `Date.now()`).
 */
export function uuidv7(timestampMs: number = Date.now()): string {
	if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_TIMESTAMP_MS) {
		throw new RangeError(
			`uuidv7 timestamp must be an integer between 0 and ${MAX_TIMESTAMP_MS} (got ${timestampMs})`,
		);
	}

	const bytes = randomBytes(16);

	let ms = timestampMs;
	for (let i = 5; i >= 0; i--) {
		bytes[i] = ms % 256;
		ms = Math.floor(ms / 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
