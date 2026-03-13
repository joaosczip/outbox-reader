function getEnvOrThrow(key: string): string {
	const value = process.env[key];
	if (!value) throw new Error(`Missing required environment variable: ${key}`);
	return value;
}

export const config = {
	databaseUrl: getEnvOrThrow("DATABASE_URL"),
};
