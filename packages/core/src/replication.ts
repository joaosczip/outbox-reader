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

	await replicationService.subscribe(plugin, slotName);
	return replicationService;
};
