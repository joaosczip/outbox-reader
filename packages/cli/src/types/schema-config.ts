import type { ColumnNaming } from "../utils/column-naming";

export interface SchemaGenerationConfig {
	/**
	 * Path to the schema.prisma file.
	 * If not provided, defaults to './prisma/schema.prisma'
	 */
	schemaPath?: string;

	/**
	 * Name of the outbox model in the schema.
	 * Defaults to 'OutboxRecord'
	 */
	modelName?: string;

	/**
	 * Name of the table in the database.
	 * Defaults to 'outbox'
	 */
	tableName?: string;

	/**
	 * Whether to generate migration files.
	 * Defaults to true
	 */
	generateMigration?: boolean;

	/**
	 * Migration name for the outbox table creation.
	 * Defaults to 'add_outbox_table'
	 */
	migrationName?: string;

	/**
	 * Custom fields to add to the outbox model.
	 * These will be appended to the standard outbox fields.
	 */
	customFields?: Record<string, string>;

	/**
	 * Column naming convention for the outbox table.
	 * Defaults to 'snake_case'.
	 */
	columnNaming?: ColumnNaming;
}

/** Result of running an external command (the shape of `spawnSync`'s result that matters). */
export interface CommandResult {
	status: number | null;
	error?: Error;
}

/** Runs `command` with `args` (no shell) and inherited stdio. */
export type CommandRunner = (command: string, args: string[]) => CommandResult;

export interface OutboxSchemaGenerationOptions {
	config?: SchemaGenerationConfig;
	configPath?: string;
	/** Overrides how `prisma migrate dev` is executed (for tests). Defaults to spawnSync without a shell. */
	runCommand?: CommandRunner;
}
