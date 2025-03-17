import { LogicalReplicationService, Wal2Json, Wal2JsonPlugin } from "pg-logical-replication";

type StartReplicationParams = {
	connectionString: string;
	slotName: string;
	onChange: (replicationOutput: Wal2Json.Output) => Promise<void>;
};

export const startReplication = async ({ connectionString, slotName, onChange }: StartReplicationParams) => {
	const plugin = new Wal2JsonPlugin();

	const replicationService = new LogicalReplicationService({
		connectionString: `${connectionString}?replication=database`,
	});

	replicationService.on("data", async (_, log: Wal2Json.Output) => onChange(log));

	await replicationService.subscribe(plugin, slotName);
};
