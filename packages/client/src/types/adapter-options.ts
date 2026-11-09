import type { ColumnNaming } from "../utils/column-naming";

/**
 * Where the built-in adapters write. Must match the values passed to
 * `outy create migration --table-name/--column-naming` and to core's
 * `TABLE_NAME` / `COLUMN_NAMING` environment variables.
 */
export interface OutboxTableOptions {
	/** Logical table name (`_`-separated); transformed by `columnNaming` like the CLI/core do. Default `"outbox"`. */
	tableName?: string;
	/** Column (and table) naming convention. Default `"snake_case"`. */
	columnNaming?: ColumnNaming;
}
