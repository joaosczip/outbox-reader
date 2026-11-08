import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { LogicalReplicationService, type Wal2Json } from "pg-logical-replication";
import { buildReplicationConnectionString, startReplication } from "../src/replication";

// The real LogicalReplicationService is used so that the library's own event
// dispatch (`emitAsync`, used by its flowControl queue) is exercised. Only the
// network-touching methods are stubbed via prototype spies, which are restored
// after each test (unlike `mock.module`, which would leak into the e2e suite).

type InternalService = LogicalReplicationService & {
	clientConfig: { connectionString: string };
	config: { acknowledge: { auto: boolean; timeoutSeconds: number }; flowControl: { enabled: boolean } };
};

const walOutput = (): Wal2Json.Output => ({ change: [] }) as unknown as Wal2Json.Output;

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

describe("buildReplicationConnectionString", () => {
	it("adds replication=database to a connection string without query params", () => {
		const result = new URL(buildReplicationConnectionString("postgres://user:pass@localhost:5432/db"));

		expect(result.searchParams.getAll("replication")).toEqual(["database"]);
		expect(result.pathname).toBe("/db");
	});

	it("keeps existing query params and adds replication=database exactly once", () => {
		const result = buildReplicationConnectionString(
			"postgres://user:pass@localhost:5432/db?sslmode=require&application_name=outbox",
		);
		const url = new URL(result);

		expect(url.searchParams.get("sslmode")).toBe("require");
		expect(url.searchParams.get("application_name")).toBe("outbox");
		expect(url.searchParams.getAll("replication")).toEqual(["database"]);
		expect(result.match(/\?/g)?.length).toBe(1);
		expect(url.username).toBe("user");
		expect(url.password).toBe("pass");
	});

	it("does not duplicate replication when it is already present", () => {
		const url = new URL(
			buildReplicationConnectionString("postgres://localhost/db?replication=database&sslmode=require"),
		);

		expect(url.searchParams.getAll("replication")).toEqual(["database"]);
		expect(url.searchParams.get("sslmode")).toBe("require");
	});
});

describe("startReplication", () => {
	let subscribeSpy: ReturnType<typeof spyOn>;
	let acknowledgeSpy: ReturnType<typeof spyOn>;
	let onChange: ReturnType<typeof mock<(log: Wal2Json.Output) => Promise<void>>>;
	let onError: ReturnType<typeof mock<(error: unknown) => void>>;
	let service: InternalService;

	beforeEach(async () => {
		subscribeSpy = spyOn(LogicalReplicationService.prototype, "subscribe").mockResolvedValue(undefined as never);
		acknowledgeSpy = spyOn(LogicalReplicationService.prototype, "acknowledge").mockResolvedValue(true);
		onChange = mock(async (_log: Wal2Json.Output) => {});
		onError = mock((_error: unknown) => {});

		service = (await startReplication({
			connectionString: "postgres://user:pass@localhost:5432/db?sslmode=require",
			slotName: "outbox_slot",
			onChange,
			onError,
		})) as InternalService;
	});

	afterEach(() => {
		service.removeAllListeners();
		subscribeSpy.mockRestore();
		acknowledgeSpy.mockRestore();
	});

	it("subscribes to the slot with a connection string that keeps existing params", () => {
		expect(subscribeSpy).toHaveBeenCalledTimes(1);
		expect(subscribeSpy.mock.calls[0][1]).toBe("outbox_slot");

		const url = new URL(service.clientConfig.connectionString);
		expect(url.searchParams.get("sslmode")).toBe("require");
		expect(url.searchParams.getAll("replication")).toEqual(["database"]);
	});

	it("disables automatic acknowledgement and keeps flow control enabled", () => {
		expect(service.config.acknowledge.auto).toBe(false);
		expect(service.config.acknowledge.timeoutSeconds).toBe(0);
		expect(service.config.flowControl.enabled).toBe(true);
	});

	it("acknowledges the lsn only after onChange resolves", async () => {
		const processing = deferred();
		onChange.mockImplementation(() => processing.promise);
		const log = walOutput();

		const dispatch = service.emitAsync("data", "0/16B3748", log);
		await Promise.resolve();

		expect(onChange).toHaveBeenCalledWith(log);
		expect(acknowledgeSpy).not.toHaveBeenCalled();

		processing.resolve();
		await dispatch;

		expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
		expect(acknowledgeSpy).toHaveBeenCalledWith("0/16B3748");
		expect(onError).not.toHaveBeenCalled();
	});

	it("does not acknowledge and reports to onError when onChange rejects", async () => {
		const failure = new Error("publish failed");
		onChange.mockImplementation(async () => {
			throw failure;
		});

		await service.emitAsync("data", "0/16B3750", walOutput());

		expect(acknowledgeSpy).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
	});

	it("reports to onError when the acknowledgement itself fails", async () => {
		const failure = new Error("connection closed");
		acknowledgeSpy.mockRejectedValueOnce(failure);

		await service.emitAsync("data", "0/16B3758", walOutput());

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
	});

	it("forwards service 'error' events to onError", () => {
		const failure = new Error("Connection terminated unexpectedly");

		service.emit("error", failure);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
	});
});
