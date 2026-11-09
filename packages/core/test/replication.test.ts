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

describe("startReplication startup errors", () => {
	let subscribeSpy: ReturnType<typeof spyOn>;

	// Shaped like pg's DatabaseError (message + SQLSTATE code).
	const pgError = (message: string, code: string) => Object.assign(new Error(message), { code, severity: "ERROR" });

	const start = (connectionString: string, slotName = "outbox_slot") =>
		startReplication({ connectionString, slotName, onChange: async () => {}, onError: () => {} });

	const rejectionOf = async (promise: Promise<unknown>): Promise<Error & { cause?: unknown }> => {
		try {
			await promise;
		} catch (error) {
			return error as Error & { cause?: unknown };
		}
		throw new Error("expected startReplication to reject");
	};

	beforeEach(() => {
		subscribeSpy = spyOn(LogicalReplicationService.prototype, "subscribe");
	});

	afterEach(() => {
		subscribeSpy.mockRestore();
	});

	it("explains how to create a missing replication slot, without leaking the password", async () => {
		const original = pgError('replication slot "outbox_slot" does not exist', "42704");
		subscribeSpy.mockRejectedValue(original);

		const error = await rejectionOf(start("postgres://app_user:s3cr3t@localhost:5432/orders?sslmode=require"));

		expect(error.message).toBe(
			'Replication slot "outbox_slot" does not exist. Create it with: bunx @joaosczip/outy-cli setup replication -u app_user -d orders -s outbox_slot',
		);
		expect(error.message).not.toContain("s3cr3t");
		expect(error.cause).toBe(original);
	});

	it("adds -h/-p to the slot hint when the host or port differ from the CLI defaults", async () => {
		subscribeSpy.mockRejectedValue(pgError('replication slot "s1" does not exist', "42704"));

		const error = await rejectionOf(start("postgres://u%40corp:pw@db.internal:6543/my%20db", "s1"));

		expect(error.message).toBe(
			'Replication slot "s1" does not exist. Create it with: bunx @joaosczip/outy-cli setup replication -u u@corp -d "my db" -s s1 -h db.internal -p 6543',
		);
		expect(error.message).not.toContain(":pw");
	});

	it("uses placeholders in the slot hint when the connection string is not a URL", async () => {
		subscribeSpy.mockRejectedValue(pgError('replication slot "outbox_slot" does not exist', "42704"));

		const error = await rejectionOf(start("host=localhost user=app password=hunter2 dbname=orders"));

		expect(error.message).toBe(
			'Replication slot "outbox_slot" does not exist. Create it with: bunx @joaosczip/outy-cli setup replication -u <user> -d <database> -s outbox_slot',
		);
		expect(error.message).not.toContain("hunter2");
	});

	it("explains how to install wal2json when the plugin is missing", async () => {
		const original = pgError('could not access file "wal2json": No such file or directory', "58P01");
		subscribeSpy.mockRejectedValue(original);

		const error = await rejectionOf(start("postgres://u:p@localhost:5432/db"));

		expect(error.message).toBe(
			'The wal2json output plugin is not installed on the PostgreSQL server (could not access file "wal2json": No such file or directory). Install it on the database host, e.g. apt-get install postgresql-<version>-wal2json where <version> is the PostgreSQL major version, and retry.',
		);
		expect(error.cause).toBe(original);
	});

	it("explains how to enable logical decoding when wal_level is too low", async () => {
		const original = pgError("logical decoding requires wal_level >= logical", "55000");
		subscribeSpy.mockRejectedValue(original);

		const error = await rejectionOf(start("postgres://u:p@localhost:5432/db"));

		expect(error.message).toBe(
			"Logical decoding is not enabled on the PostgreSQL server (logical decoding requires wal_level >= logical). Set wal_level=logical (e.g. ALTER SYSTEM SET wal_level = logical, or start postgres with -c wal_level=logical) and restart PostgreSQL.",
		);
		expect(error.cause).toBe(original);
	});

	it("rethrows unrelated errors unchanged", async () => {
		const original = pgError('password authentication failed for user "u"', "28P01");
		subscribeSpy.mockRejectedValue(original);

		const error = await rejectionOf(start("postgres://u:p@localhost:5432/db"));

		expect(error).toBe(original);
	});
});
