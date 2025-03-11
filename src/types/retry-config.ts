export type RetryConfig = {
	jitter: string;
	maxDelayInMs: number;
	numOfAttempts: number;
	startingDelayInMs?: number;
};

export type RetryCallback = (e: Error, attempts: number) => Promise<boolean> | boolean;
