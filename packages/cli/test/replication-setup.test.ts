import { describe, expect, it, mock } from "bun:test";
import { ReplicationSetupService } from "../src/services/replication-setup";
import type { ReplicationSetupOptions } from "../src/types/replication-config";

const defaultOptions: ReplicationSetupOptions = {
	host: "localhost",
	port: 5432,
	user: "test_user",
	password: "test_pass",
	database: "test_db",
	slotName: "test_slot",
};

function makeClient(slotExists: boolean, queryError?: Error) {
	const connect = mock(() => Promise.resolve());
	const end = mock(() => Promise.resolve());
	const query = mock((text: string, _values?: unknown[]) => {
		if (queryError) return Promise.reject(queryError);
		if (text.includes("pg_replication_slots")) {
			return Promise.resolve({ rows: slotExists ? [{ "?column?": 1 }] : [] });
		}
		return Promise.resolve({ rows: [{ slot_name: defaultOptions.slotName }] });
	});
	return { connect, end, query };
}

describe("ReplicationSetupService", () => {
	it("creates slot when it does not exist", async () => {
		const client = makeClient(false);
		const service = new ReplicationSetupService(() => client);

		const result = await service.setup(defaultOptions);

		expect(result).toEqual({ created: true, alreadyExists: false, slotName: "test_slot" });
		expect(client.query).toHaveBeenCalledTimes(2);
		const calls = client.query.mock.calls;
		expect(calls[0][0]).toContain("pg_replication_slots");
		expect(calls[1][0]).toContain("pg_create_logical_replication_slot");
	});

	it("reports alreadyExists when slot is found and skips creation", async () => {
		const client = makeClient(true);
		const service = new ReplicationSetupService(() => client);

		const result = await service.setup(defaultOptions);

		expect(result).toEqual({ created: false, alreadyExists: true, slotName: "test_slot" });
		expect(client.query).toHaveBeenCalledTimes(1);
		const call = client.query.mock.calls[0];
		expect(call[0]).toContain("pg_replication_slots");
	});

	it("re-throws on connection error", async () => {
		const connectError = new Error("connection refused");
		const client = {
			connect: mock(() => Promise.reject(connectError)),
			end: mock(() => Promise.resolve()),
			query: mock(() => Promise.resolve({ rows: [] })),
		};
		const service = new ReplicationSetupService(() => client);

		await expect(service.setup(defaultOptions)).rejects.toThrow("connection refused");
	});

	it("calls client.end() even when query throws", async () => {
		const queryError = new Error("query failed");
		const client = makeClient(false, queryError);
		const service = new ReplicationSetupService(() => client);

		await expect(service.setup(defaultOptions)).rejects.toThrow("query failed");
		expect(client.end).toHaveBeenCalledTimes(1);
	});
});
