import { LogicalReplicationService, type Wal2Json, Wal2JsonPlugin } from "pg-logical-replication";

type StartReplicationParams = {
	connectionString: string;
	slotName: string;
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

export const startReplication = async ({ connectionString, slotName, onChange, onError }: StartReplicationParams) => {
	const plugin = new Wal2JsonPlugin();

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
