import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Client } from "pg";
import { LogicalReplicationService, type Wal2Json, type Wal2JsonPlugin } from "pg-logical-replication";
import {
	buildReplicationConnectionString,
	buildWal2JsonOptions,
	escapeWal2JsonTableName,
	startReplication,
} from "../src/replication";
import { applyNamingToTableName } from "../src/utils/column-naming";

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

describe("escapeWal2JsonTableName", () => {
	it("returns a plain name unchanged", () => {
		expect(escapeWal2JsonTableName("outbox")).toBe("outbox");
		expect(escapeWal2JsonTableName("outbox_events")).toBe("outbox_events");
	});

	it("escapes wal2json special characters with a backslash", () => {
		expect(escapeWal2JsonTableName("my.outbox")).toBe("my\\.outbox");
		expect(escapeWal2JsonTableName("a,b")).toBe("a\\,b");
		expect(escapeWal2JsonTableName("Foo bar")).toBe("Foo\\ bar");
		expect(escapeWal2JsonTableName("out*box")).toBe("out\\*box");
		expect(escapeWal2JsonTableName("back\\slash")).toBe("back\\\\slash");
	});

	it("escapes a single quote for wal2json and doubles it for the SQL string literal", () => {
		expect(escapeWal2JsonTableName("o'box")).toBe("o\\''box");
	});

	it("keeps the case of camelCase and PascalCase table names", () => {
		expect(escapeWal2JsonTableName(applyNamingToTableName("outbox_events", "camelCase"))).toBe("outboxEvents");
		expect(escapeWal2JsonTableName(applyNamingToTableName("outbox_events", "PascalCase"))).toBe("OutboxEvents");
	});
});

describe("buildWal2JsonOptions", () => {
	it("restricts the stream to inserts on the table in any schema and drops column types", () => {
		expect(buildWal2JsonOptions("outbox")).toEqual({
			addTables: "*.outbox",
			actions: "insert",
			includeTypes: false,
		});
	});

	it("escapes the table name inside add-tables", () => {
		expect(buildWal2JsonOptions("my.outbox").addTables).toBe("*.my\\.outbox");
	});
});

describe("startReplication wal2json plugin", () => {
	let subscribeSpy: ReturnType<typeof spyOn>;
	let service: LogicalReplicationService | undefined;

	const subscribedPlugin = () => subscribeSpy.mock.calls[0][0] as Wal2JsonPlugin;

	const renderStartSql = async (plugin: Wal2JsonPlugin) => {
		const query = mock(async (_sql: string) => ({}));
		await plugin.start({ query } as unknown as Client, "outbox_slot", "0/0");
		return query.mock.calls[0][0];
	};

	beforeEach(() => {
		subscribeSpy = spyOn(LogicalReplicationService.prototype, "subscribe").mockResolvedValue(undefined as never);
	});

	afterEach(() => {
		service?.removeAllListeners();
		service = undefined;
		subscribeSpy.mockRestore();
	});

	it("filters the stream to inserts on the outbox table when tableName is given", async () => {
		service = await startReplication({
			connectionString: "postgres://localhost/db",
			slotName: "outbox_slot",
			tableName: "outbox",
			onChange: async () => {},
		});

		const plugin = subscribedPlugin();
		expect(plugin.name).toBe("wal2json");
		expect(plugin.options).toEqual({ addTables: "*.outbox", actions: "insert", includeTypes: false });
		expect(await renderStartSql(plugin)).toBe(
			`START_REPLICATION SLOT "outbox_slot" LOGICAL 0/0 ("add-tables" '*.outbox' , "actions" 'insert' , "include-types" 'off')`,
		);
	});

	it("renders an escaped physical table name (PascalCase) in the START_REPLICATION options", async () => {
		service = await startReplication({
			connectionString: "postgres://localhost/db",
			slotName: "outbox_slot",
			tableName: applyNamingToTableName("outbox_events", "PascalCase"),
			onChange: async () => {},
		});

		expect(await renderStartSql(subscribedPlugin())).toContain(`"add-tables" '*.OutboxEvents'`);
	});

	it("keeps the unfiltered default plugin when tableName is omitted (backwards compatible)", async () => {
		service = await startReplication({
			connectionString: "postgres://localhost/db",
			slotName: "outbox_slot",
			onChange: async () => {},
		});

		const plugin = subscribedPlugin();
		expect(plugin.options).toEqual({});
		expect(await renderStartSql(plugin)).toBe(`START_REPLICATION SLOT "outbox_slot" LOGICAL 0/0`);
	});
});
