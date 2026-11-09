import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ArgumentsCamelCase } from "yargs";
import { handler } from "../src/cli/commands/setup/replication";
import { ReplicationSetupService } from "../src/services/replication-setup";

type HandlerArgs = Parameters<typeof handler>[0];

describe("outy setup replication handler", () => {
	let setupSpy: ReturnType<typeof spyOn>;
	let exitSpy: ReturnType<typeof spyOn>;
	let logSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;
	let argv: HandlerArgs;

	const output = (spy: ReturnType<typeof spyOn>) => spy.mock.calls.map((call) => call.join(" ")).join("\n");

	beforeEach(() => {
		setupSpy = spyOn(ReplicationSetupService.prototype, "setup");
		exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		argv = {
			_: [],
			$0: "outy",
			host: "localhost",
			port: 5432,
			user: "outbox",
			password: "secret",
			database: "app",
			slotName: "orders_slot",
			"slot-name": "orders_slot",
		} as ArgumentsCamelCase<HandlerArgs>;
	});

	afterEach(() => {
		setupSpy.mockRestore();
		exitSpy.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("points to the README instead of a repository-local pg.conf in the prerequisites", async () => {
		setupSpy.mockResolvedValue({ created: true, alreadyExists: false, slotName: "orders_slot" });

		await handler(argv);

		const logs = output(logSpy);
		expect(logs).toContain("https://github.com/joaosczip/outbox-reader#outy-setup-replication");
		expect(logs).toContain("wal2json");
		expect(logs).not.toContain("pg.conf in this repository");
	});

	it("prints next steps with the slot name after creating the slot", async () => {
		setupSpy.mockResolvedValue({ created: true, alreadyExists: false, slotName: "orders_slot" });

		await handler(argv);

		const logs = output(logSpy);
		expect(setupSpy).toHaveBeenCalledWith(
			expect.objectContaining({ user: "outbox", password: "secret", database: "app", slotName: "orders_slot" }),
		);
		expect(logs).toContain('Replication slot "orders_slot" created successfully.');
		expect(logs).toContain("outy create migration");
		expect(logs).toContain("REPLICATION_SLOT_NAME=orders_slot");
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("prints next steps when the slot already exists", async () => {
		setupSpy.mockResolvedValue({ created: false, alreadyExists: true, slotName: "orders_slot" });

		await handler(argv);

		const logs = output(logSpy);
		expect(logs).toContain("already exists");
		expect(logs).toContain("REPLICATION_SLOT_NAME=orders_slot");
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("prints the hint matching the error instead of always the REPLICATION hint (regression)", async () => {
		setupSpy.mockRejectedValue(new Error('logical decoding requires "wal_level" >= "logical"'));

		await handler(argv);

		const errors = output(errorSpy);
		expect(errors).toContain("Failed to create replication slot");
		expect(errors).toContain("wal_level = logical");
		expect(errors).not.toContain("REPLICATION role");
		expect(output(logSpy)).not.toContain("Next steps");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
