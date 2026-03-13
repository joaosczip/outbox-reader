export type MigrationTarget = "prisma" | "sequelize" | "sql";

export interface PrismaMigrationOptions {
	target: "prisma";
	schemaPath?: string;
	modelName?: string;
	tableName?: string;
	migrationName?: string;
	configPath?: string;
}

export interface SequelizeMigrationOptions {
	target: "sequelize";
	migrationsPath?: string;
	migrationName?: string;
	tableName?: string;
	configPath?: string;
}

export interface SqlMigrationOptions {
	target: "sql";
	tableName?: string;
	output?: string;
}

export type MigrationAdapterOptions = PrismaMigrationOptions | SequelizeMigrationOptions | SqlMigrationOptions;
