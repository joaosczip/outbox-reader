import {
	LogicalReplicationService,
	type Wal2Json,
	Wal2JsonPlugin,
	type Wal2JsonPluginOptions,
} from "pg-logical-replication";

type StartReplicationParams = {
	connectionString: string;
	slotName: string;
	/**
	 * Physical outbox table name (after `applyNamingToTableName`). When set, wal2json
	 * streams only INSERTs on this table; when omitted, every change is streamed.
	 */
	tableName?: string;
	onChange: (replicationOutput: Wal2Json.Output) => Promise<void>;
	/**
	 * Called when processing a WAL message fails (the LSN is then NOT acknowledged)
	 * or when the replication service emits an `error` (e.g. a dropped connection).
	 */
	onError?: (error: unknown) => void;
};

/**
 * Returns the connection string with `replication=database` set exactly once,
 * preserving any existing query params (e.g. `sslmode=require`).
 *
 * pg-logical-replication forces `replication: "database"` on the pg Client it creates,
 * but query params parsed from the connection string take precedence over the
 * client config in pg, so the param is normalised here as well. Strings that are
 * not URLs (e.g. keyword/value DSNs) are returned unchanged.
 */
export const buildReplicationConnectionString = (connectionString: string): string => {
	if (!URL.canParse(connectionString)) return connectionString;

	const url = new URL(connectionString);
	url.searchParams.set("replication", "database");
	return url.toString();
};

/**
 * Escapes a table name for wal2json's `add-tables`/`filter-tables` options.
 *
 * wal2json requires space, single quote, comma, period and asterisk (and the
 * backslash itself) to be escaped with a backslash. pg-logical-replication then
 * renders the value inside a single-quoted SQL literal without escaping it, so a
 * single quote is additionally doubled for that literal. Case is preserved
 * (wal2json matches schema and table names case-sensitively).
 */
export const escapeWal2JsonTableName = (tableName: string): string =>
	tableName.replace(/[\\ ',.*]/g, (char) => (char === "'" ? "\\''" : `\\${char}`));

/**
 * wal2json options that make PostgreSQL decode and stream only what
 * `OutboxProcessor.filterChanges` uses: INSERTs on the outbox table (in any
 * schema), without column type metadata. The service's own UPDATEs on the
 * outbox and changes on every other table are dropped server-side.
 */
export const buildWal2JsonOptions = (tableName: string): Wal2JsonPluginOptions => ({
	addTables: `*.${escapeWal2JsonTableName(tableName)}`,
	actions: "insert",
	includeTypes: false,
});

const CLI_DEFAULT_HOST = "localhost";
const CLI_DEFAULT_PORT = "5432";

const shellArg = (value: string): string => (/^[\w@.%+:/=-]+$/.test(value) ? value : JSON.stringify(value));

/**
 * Builds the `outy setup replication` command for a missing slot. User, database, host
 * and port come from the connection string when it is a URL (placeholders otherwise);
 * the password is never included.
 */
const buildCreateSlotCommand = (connectionString: string, slotName: string): string => {
	let user = "<user>";
	let database = "<database>";
	const extra: string[] = [];

	if (URL.canParse(connectionString)) {
		const url = new URL(connectionString);
		const decode = (value: string) => {
			try {
				return decodeURIComponent(value);
			} catch {
				return value;
			}
		};
		if (url.username) user = shellArg(decode(url.username));
		const dbName = decode(url.pathname.replace(/^\//, ""));
		if (dbName) database = shellArg(dbName);
		if (url.hostname && url.hostname !== CLI_DEFAULT_HOST) extra.push(`-h ${shellArg(url.hostname)}`);
		if (url.port && url.port !== CLI_DEFAULT_PORT) extra.push(`-p ${url.port}`);
	}

	return [
		`bunx @joaosczip/outy-cli setup replication -u ${user} -d ${database} -s ${shellArg(slotName)}`,
		...extra,
	].join(" ");
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;

/**
 * Turns well-known PostgreSQL replication setup errors into actionable errors (original
 * kept as `cause`). Any other error is returned unchanged.
 */
const toActionableReplicationError = (error: unknown, connectionString: string, slotName: string): unknown => {
	const message = errorMessage(error);

	// 42704 undefined_object: START_REPLICATION on a slot that does not exist.
	if (
		/replication slot ".*" does not exist/.test(message) ||
		(errorCode(error) === "42704" && /slot/i.test(message))
	) {
		return new Error(
			`Replication slot "${slotName}" does not exist. Create it with: ${buildCreateSlotCommand(connectionString, slotName)}`,
			{ cause: error },
		);
	}

	if (/could not access file "wal2json"/.test(message)) {
		return new Error(
			`The wal2json output plugin is not installed on the PostgreSQL server (${message}). Install it on the database host, e.g. apt-get install postgresql-<version>-wal2json where <version> is the PostgreSQL major version, and retry.`,
			{ cause: error },
		);
	}

	if (/wal_level/.test(message)) {
		return new Error(
			`Logical decoding is not enabled on the PostgreSQL server (${message}). Set wal_level=logical (e.g. ALTER SYSTEM SET wal_level = logical, or start postgres with -c wal_level=logical) and restart PostgreSQL.`,
			{ cause: error },
		);
	}

	return error;
};

export const startReplication = async ({
	connectionString,
	slotName,
	tableName,
	onChange,
	onError,
}: StartReplicationParams) => {
	const plugin = new Wal2JsonPlugin(tableName ? buildWal2JsonOptions(tableName) : undefined);

	const replicationService = new LogicalReplicationService(
		{ connectionString: buildReplicationConnectionString(connectionString) },
		// flowControl makes the library await this async `data` handler before handling
		// the next message; acknowledgement is manual so an LSN is only confirmed to
		// PostgreSQL after onChange has finished successfully.
		{ flowControl: { enabled: true }, acknowledge: { auto: false, timeoutSeconds: 0 } },
	);

	replicationService.on("error", (error: Error) => onError?.(error));

	replicationService.on("data", async (lsn: string, log: Wal2Json.Output) => {
		try {
			await onChange(log);
			await replicationService.acknowledge(lsn);
		} catch (error) {
			onError?.(error);
		}
	});

	try {
		await replicationService.subscribe(plugin, slotName);
	} catch (error) {
		throw toActionableReplicationError(error, connectionString, slotName);
	}
	return replicationService;
};
