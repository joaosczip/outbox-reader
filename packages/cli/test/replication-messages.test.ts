import { describe, expect, it } from "bun:test";
import { getReplicationErrorHints, getReplicationNextSteps } from "../src/utils/replication-messages";

function pgError(message: string, code?: string): Error {
	return Object.assign(new Error(message), code ? { code } : {});
}

describe("getReplicationErrorHints", () => {
	it("tells the user to set wal_level=logical and restart when logical decoding is disabled", () => {
		const hints = getReplicationErrorHints(pgError('logical decoding requires "wal_level" >= "logical"', "55000"));

		expect(hints.join("\n")).toContain("wal_level = logical");
		expect(hints.join("\n")).toContain("restart");
		// regression: every error used to print the REPLICATION role hint
		expect(hints.join("\n")).not.toContain("REPLICATION");
	});

	it("tells the user to install wal2json when the output plugin is missing", () => {
		const hints = getReplicationErrorHints(
			pgError('could not access file "wal2json": No such file or directory', "58P01"),
		);

		expect(hints.join("\n")).toContain("postgresql-<version>-wal2json");
		expect(hints.join("\n")).not.toContain("REPLICATION");
	});

	it.each([
		["permission denied to use replication slots", "42501"],
		["must be superuser or replication role to use replication slots", "42501"],
	])("tells the user to grant the REPLICATION role for %p", (message, code) => {
		const hints = getReplicationErrorHints(pgError(message, code));

		expect(hints.join("\n")).toContain("ALTER ROLE <user> WITH REPLICATION");
	});

	it("tells the user to raise max_replication_slots when all slots are in use", () => {
		const hints = getReplicationErrorHints(pgError("all replication slots are in use", "53400"));

		expect(hints.join("\n")).toContain("max_replication_slots");
		expect(hints.join("\n")).not.toContain("REPLICATION role");
	});

	it("tells the user to check host and port when the connection is refused", () => {
		const hints = getReplicationErrorHints(pgError("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED"));

		expect(hints.join("\n")).toContain("--host");
		expect(hints.join("\n")).toContain("--port");
	});

	it("tells the user to check credentials when authentication fails", () => {
		const hints = getReplicationErrorHints(pgError('password authentication failed for user "outbox"', "28P01"));

		expect(hints.join("\n")).toContain("PGPASSWORD");
		expect(hints.join("\n")).toContain("pg_hba.conf");
	});

	it("tells the user to check the database name when it does not exist", () => {
		const hints = getReplicationErrorHints(pgError('database "nope" does not exist', "3D000"));

		expect(hints.join("\n")).toContain("--database");
	});

	it("explains the allowed characters when the slot name is invalid", () => {
		const hints = getReplicationErrorHints(
			pgError('replication slot name "My-Slot" contains invalid character', "42602"),
		);

		expect(hints.join("\n")).toContain("lower-case letters, numbers and underscores");
	});

	it("falls back to a generic prerequisites hint for unknown errors", () => {
		const hints = getReplicationErrorHints(new Error("something unexpected"));

		expect(hints.join("\n")).toContain("wal_level = logical");
		expect(hints.join("\n")).toContain("wal2json");
		expect(hints.join("\n")).toContain("REPLICATION");
	});

	it("accepts non-Error values", () => {
		expect(getReplicationErrorHints("wal2json missing").join("\n")).toContain("postgresql-<version>-wal2json");
	});
});

describe("getReplicationNextSteps", () => {
	it("points to outy create migration and the REPLICATION_SLOT_NAME of the created slot", () => {
		const steps = getReplicationNextSteps("orders_slot").join("\n");

		expect(steps).toContain("outy create migration");
		expect(steps).toContain("REPLICATION_SLOT_NAME=orders_slot");
		expect(steps).toContain("outy setup client");
	});
});
