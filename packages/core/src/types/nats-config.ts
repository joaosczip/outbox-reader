export interface NATSConnectionConfig {
	/**
	 * NATS server URLs. Can be a single server or an array of servers for clustering.
	 * @example ["nats://localhost:4222"] or ["nats://server1:4222", "nats://server2:4222"]
	 */
	servers: string | string[];

	/**
	 * Connection name for identification in server logs
	 */
	name?: string;

	/**
	 * Username for authentication
	 */
	user?: string;

	/**
	 * Password for authentication
	 */
	pass?: string;

	/**
	 * Token for authentication
	 */
	token?: string;

	/**
	 * Maximum number of reconnection attempts
	 * @default -1 (unlimited)
	 */
	maxReconnectAttempts?: number;

	/**
	 * Time in milliseconds between reconnection attempts
	 * @default 2000
	 */
	reconnectTimeWait?: number;

	/**
	 * Connection timeout in milliseconds
	 * @default 20000
	 */
	timeout?: number;

	/**
	 * Enable/disable verbose logging
	 * @default false
	 */
	verbose?: boolean;

	/**
	 * Enable/disable pedantic mode
	 * @default false
	 */
	pedantic?: boolean;
}
