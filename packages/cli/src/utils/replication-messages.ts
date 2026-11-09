export const REPLICATION_DOCS_URL = "https://github.com/joaosczip/outbox-reader#outy-setup-replication";

interface HintRule {
	codes: string[];
	pattern: RegExp;
	hints: string[];
}

const HINT_RULES: HintRule[] = [
	{
		codes: [],
		pattern: /wal_level/i,
		hints: [
			"Logical decoding is disabled on the server.",
			"Set `wal_level = logical` in postgresql.conf (or `ALTER SYSTEM SET wal_level = logical;`) and restart PostgreSQL.",
		],
	},
	{
		codes: ["58P01"],
		pattern: /wal2json/i,
		hints: [
			"The wal2json output plugin is not installed on the PostgreSQL server.",
			"Install it (e.g. `apt install postgresql-<version>-wal2json`, or build it from https://github.com/eulerto/wal2json) and retry.",
		],
	},
	{
		codes: ["42501"],
		pattern: /permission denied|replication role|REPLICATION attribute|must be superuser/i,
		hints: [
			"The PostgreSQL user is not allowed to create replication slots.",
			"Grant the role as a superuser: `ALTER ROLE <user> WITH REPLICATION;`",
		],
	},
	{
		codes: ["53400"],
		pattern: /replication slots are in use|max_replication_slots/i,
		hints: [
			"No free replication slot is available.",
			"Raise `max_replication_slots` in postgresql.conf and restart, or drop unused slots (`SELECT pg_drop_replication_slot('<name>');`).",
		],
	},
	{
		codes: ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"],
		pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/,
		hints: ["Could not reach PostgreSQL. Check that the server is running and that --host/--port are correct."],
	},
	{
		codes: ["28P01", "28000"],
		pattern: /password authentication failed|no pg_hba\.conf entry/i,
		hints: [
			"Authentication failed. Check --user and the password (PGPASSWORD or -P/--password),",
			"and that pg_hba.conf allows this user to connect to the database.",
		],
	},
	{
		codes: ["3D000"],
		pattern: /database .* does not exist/i,
		hints: ["The database does not exist. Check the --database option."],
	},
	{
		codes: ["42602"],
		pattern: /invalid character/i,
		hints: ["Replication slot names may only contain lower-case letters, numbers and underscores."],
	},
];

const GENERIC_HINTS = [
	"Check the prerequisites: `wal_level = logical` (server restart required), the wal2json plugin installed,",
	"and a PostgreSQL user with the LOGIN and REPLICATION roles.",
	`See ${REPLICATION_DOCS_URL}`,
];

/** Maps a replication setup failure to actionable hints for the user. */
export function getReplicationErrorHints(error: unknown): string[] {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: unknown } | null)?.code;

	const rule = HINT_RULES.find(
		(candidate) => (typeof code === "string" && candidate.codes.includes(code)) || candidate.pattern.test(message),
	);

	return rule ? rule.hints : GENERIC_HINTS;
}

/** What to do once the replication slot exists. */
export function getReplicationNextSteps(slotName: string): string[] {
	return [
		"Next steps:",
		"  1. Create the outbox table:        outy create migration   (see `outy create migration --help`)",
		`  2. Configure the outbox service:   REPLICATION_SLOT_NAME=${slotName} (and DATABASE_URL pointing at this database)`,
		"  3. Install the client in your app: outy setup client",
	];
}
