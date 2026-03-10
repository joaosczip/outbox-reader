export type CreateOutboxEvent = {
	aggregateId: string;
	aggregateType: string;
	eventType: string;
	payload: unknown;
};
