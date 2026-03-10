export interface ReplicationSetupOptions {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	slotName: string;
}

export interface ReplicationSetupResult {
	created: boolean;
	alreadyExists: boolean;
	slotName: string;
}
