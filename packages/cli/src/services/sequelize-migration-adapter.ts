import path from "node:path";
import type { SequelizeMigrationOptions } from "../types/migration-adapter-config";
import type { MigrationAdapter } from "./migration-adapter";

export type FsWriter = (filePath: string, content: string) => Promise<void>;
export type RequireFn = (id: string) => unknown;
export type Clock = () => Date;

const defaultFsWriter: FsWriter = async (filePath, content) => {
	await Bun.write(filePath, content);
};

const defaultRequireFn: RequireFn = (id) => require(id);

const defaultClock: Clock = () => new Date();

export class SequelizeMigrationAdapter implements MigrationAdapter {
	constructor(
		private readonly fsWriter: FsWriter = defaultFsWriter,
		private readonly requireFn: RequireFn = defaultRequireFn,
		private readonly clock: Clock = defaultClock,
	) {}

	async createMigration(options: SequelizeMigrationOptions): Promise<void> {
		const migrationsPath = options.migrationsPath ?? this.discoverMigrationsPath(options.configPath);
		const migrationName = options.migrationName ?? "create-outbox-table";
		const tableName = options.tableName ?? "outbox";

		const timestamp = this.formatTimestamp(this.clock());
		const filename = `${timestamp}-${migrationName}.js`;
		const filePath = path.join(migrationsPath, filename);

		const content = this.renderMigration(tableName);
		await this.fsWriter(filePath, content);

		console.log(`Created Sequelize migration at ${filePath}`);
	}

	private discoverMigrationsPath(configPath?: string): string {
		const sequelizercPath = configPath ?? path.join(process.cwd(), ".sequelizerc");

		try {
			const config = this.requireFn(sequelizercPath) as Record<string, unknown>;
			const migrationsPath = config["migrations-path"];
			if (typeof migrationsPath === "string") {
				return migrationsPath;
			}
		} catch {
			// fall through to default
		}

		return path.join(process.cwd(), "migrations");
	}

	private formatTimestamp(date: Date): string {
		const pad = (n: number, len = 2) => String(n).padStart(len, "0");
		return (
			String(date.getFullYear()) +
			pad(date.getMonth() + 1) +
			pad(date.getDate()) +
			pad(date.getHours()) +
			pad(date.getMinutes()) +
			pad(date.getSeconds())
		);
	}

	private renderMigration(tableName: string): string {
		return `"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "pg_uuidv7"');

    await queryInterface.createTable("${tableName}", {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: Sequelize.literal("uuid_generate_v7()"),
      },
      aggregate_id: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      aggregate_type: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      event_type: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      payload: {
        type: Sequelize.JSONB,
        allowNull: false,
      },
      status: {
        type: Sequelize.TEXT,
        allowNull: false,
        defaultValue: "PENDING",
      },
      attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      processed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      sequence_number: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("${tableName}", ["status"]);
    await queryInterface.addIndex("${tableName}", ["created_at"]);
    await queryInterface.addIndex("${tableName}", ["sequence_number"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("${tableName}");
  },
};
`;
	}
}
