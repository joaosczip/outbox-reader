import type { ColumnNaming } from "../utils/column-naming";

export type MigrationTarget = "prisma" | "sequelize" | "sql";

export interface PrismaMigrationOptions {
	target: "prisma";
	schemaPath?: string;
	modelName?: string;
	tableName?: string;
	migrationName?: string;
	configPath?: string;
	columnNaming?: ColumnNaming;
}

export interface SequelizeMigrationOptions {
	target: "sequelize";
	migrationsPath?: string;
	migrationName?: string;
	tableName?: string;
	configPath?: string;
	columnNaming?: ColumnNaming;
}

export interface SqlMigrationOptions {
	target: "sql";
	tableName?: string;
	output?: string;
	columnNaming?: ColumnNaming;
}

export type MigrationAdapterOptions = PrismaMigrationOptions | SequelizeMigrationOptions | SqlMigrationOptions;
