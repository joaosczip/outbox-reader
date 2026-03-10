import { Client } from "pg";
import type { ReplicationSetupOptions, ReplicationSetupResult } from "../types/replication-config";

type ClientFactory = (opts: {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}) => {
	connect(): Promise<void>;
	query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
	end(): Promise<void>;
};

const defaultClientFactory: ClientFactory = (opts) => new Client(opts);

export class ReplicationSetupService {
	constructor(private readonly clientFactory: ClientFactory = defaultClientFactory) {}

	async setup(options: ReplicationSetupOptions): Promise<ReplicationSetupResult> {
		const client = this.clientFactory({
			host: options.host,
			port: options.port,
			user: options.user,
			password: options.password,
			database: options.database,
		});

		await client.connect();

		try {
			const exists = await this.slotExists(client, options.slotName);
			if (exists) {
				return { created: false, alreadyExists: true, slotName: options.slotName };
			}

			await this.createSlot(client, options.slotName);
			return { created: true, alreadyExists: false, slotName: options.slotName };
		} finally {
			await client.end();
		}
	}

	private async slotExists(client: ReturnType<ClientFactory>, slotName: string): Promise<boolean> {
		const result = await client.query("SELECT 1 FROM pg_replication_slots WHERE slot_name = $1", [slotName]);
		return result.rows.length > 0;
	}

	private async createSlot(client: ReturnType<ClientFactory>, slotName: string): Promise<void> {
		await client.query("SELECT * FROM pg_create_logical_replication_slot($1, 'wal2json')", [slotName]);
	}
}
