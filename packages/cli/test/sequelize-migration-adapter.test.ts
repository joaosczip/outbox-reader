import { beforeEach, describe, expect, it, mock } from "bun:test";
import path from "node:path";
import { SequelizeMigrationAdapter, type FsWriter, type RequireFn, type Clock } from "../src/services/sequelize-migration-adapter";

function makeAdapter({
  fsWriter,
  requireFn,
  clock,
}: {
  fsWriter?: FsWriter;
  requireFn?: RequireFn;
  clock?: Clock;
} = {}): { adapter: SequelizeMigrationAdapter; writtenFiles: Array<{ path: string; content: string }> } {
  const writtenFiles: Array<{ path: string; content: string }> = [];
  const defaultFsWriter: FsWriter = async (filePath, content) => { writtenFiles.push({ path: filePath, content }); };
  const defaultRequireFn: RequireFn = () => ({});
  const fixedDate = new Date("2024-06-15T10:30:45.000Z");
  const defaultClock: Clock = () => fixedDate;

  const adapter = new SequelizeMigrationAdapter(
    fsWriter ?? defaultFsWriter,
    requireFn ?? defaultRequireFn,
    clock ?? defaultClock,
  );

  return { adapter, writtenFiles };
}

describe("SequelizeMigrationAdapter", () => {
  describe("createMigration - default path", () => {
    it("writes the migration file to the default migrations directory when no path is given", async () => {
      const { adapter, writtenFiles } = makeAdapter();

      await adapter.createMigration({ target: "sequelize" });

      expect(writtenFiles).toHaveLength(1);
      expect(writtenFiles[0].path).toContain("migrations");
    });

    it("uses the default table name 'outbox' in the migration content", async () => {
      const { adapter, writtenFiles } = makeAdapter();

      await adapter.createMigration({ target: "sequelize" });

      expect(writtenFiles[0].content).toContain('"outbox"');
    });
  });

  describe("createMigration - .sequelizerc discovery", () => {
    it("reads migrations-path from .sequelizerc when present", async () => {
      const requireFn: RequireFn = mock((id: string) => {
        if (id.endsWith(".sequelizerc")) {
          return { "migrations-path": "/custom/migrations" };
        }
        return {};
      });

      const { adapter, writtenFiles } = makeAdapter({ requireFn });

      await adapter.createMigration({ target: "sequelize" });

      expect(writtenFiles[0].path).toStartWith("/custom/migrations");
    });

    it("falls back to default migrations directory when .sequelizerc parse fails", async () => {
      const requireFn: RequireFn = mock(() => {
        throw new Error("cannot parse .sequelizerc");
      });

      const { adapter, writtenFiles } = makeAdapter({ requireFn });

      await adapter.createMigration({ target: "sequelize" });

      expect(writtenFiles[0].path).toContain("migrations");
    });

    it("falls back to default when .sequelizerc has no migrations-path key", async () => {
      const requireFn: RequireFn = mock(() => ({}));
      const { adapter, writtenFiles } = makeAdapter({ requireFn });

      await adapter.createMigration({ target: "sequelize" });

      const expectedDefault = path.join(process.cwd(), "migrations");
      expect(writtenFiles[0].path).toStartWith(expectedDefault);
    });
  });

  describe("createMigration - --migrations-path override", () => {
    it("uses --migrations-path over .sequelizerc", async () => {
      const requireFn: RequireFn = mock(() => ({ "migrations-path": "/from-sequelizerc" }));
      const { adapter, writtenFiles } = makeAdapter({ requireFn });

      await adapter.createMigration({ target: "sequelize", migrationsPath: "/override/migrations" });

      expect(writtenFiles[0].path).toStartWith("/override/migrations");
    });
  });

  describe("createMigration - filename format", () => {
    it("generates a timestamped filename with migration name", async () => {
      // Fixed date: 2024-06-15T10:30:45 UTC → timestamp 20240615103045
      const clock: Clock = () => new Date("2024-06-15T10:30:45.000Z");
      const { adapter, writtenFiles } = makeAdapter({ clock });

      await adapter.createMigration({ target: "sequelize", migrationName: "create-outbox-table" });

      const filename = path.basename(writtenFiles[0].path);
      expect(filename).toMatch(/^\d{14}-create-outbox-table\.js$/);
    });

    it("uses the default migration name when none is given", async () => {
      const { adapter, writtenFiles } = makeAdapter();

      await adapter.createMigration({ target: "sequelize" });

      const filename = path.basename(writtenFiles[0].path);
      expect(filename).toContain("create-outbox-table");
    });
  });

  describe("createMigration - content correctness", () => {
    it("includes all required outbox columns in the migration", async () => {
      const { adapter, writtenFiles } = makeAdapter();

      await adapter.createMigration({ target: "sequelize" });

      const { content } = writtenFiles[0];
      expect(content).toContain('CREATE EXTENSION IF NOT EXISTS "pg_uuidv7"');
      expect(content).toContain("uuid_generate_v7()");
      expect(content).toContain("queryInterface.createTable");
      expect(content).toContain("aggregate_id");
      expect(content).toContain("aggregate_type");
      expect(content).toContain("event_type");
      expect(content).toContain("payload");
      expect(content).toContain("status");
      expect(content).toContain("attempts");
      expect(content).toContain("created_at");
      expect(content).toContain("processed_at");
      expect(content).toContain("sequence_number");
    });

    it("includes up and down migration methods", async () => {
      const { adapter, writtenFiles } = makeAdapter();

      await adapter.createMigration({ target: "sequelize" });

      const { content } = writtenFiles[0];
      expect(content).toContain("async up(queryInterface");
      expect(content).toContain("async down(queryInterface");
      expect(content).toContain("queryInterface.dropTable");
    });
  });

  describe("createMigration - custom table name", () => {
    it("uses the provided table name in the migration", async () => {
      const { adapter, writtenFiles } = makeAdapter();

      await adapter.createMigration({ target: "sequelize", tableName: "custom_outbox" });

      expect(writtenFiles[0].content).toContain('"custom_outbox"');
      expect(writtenFiles[0].content).not.toContain('"outbox"');
    });
  });
});
