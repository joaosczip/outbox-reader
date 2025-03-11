export enum OutboxStatus {
	PENDING = "PENDING",
	PROCESSED = "PROCESSED",
	FAILED = "FAILED",
}

export type OutboxConstructor = {
	aggregateId: string;
	aggregateType: string;
	eventType: string;
	payload: unknown;
} & Partial<{
	id: string;
	createdAt: string;
	processedAt: string;
	status: OutboxStatus;
	attempts: number;
	sequenceNumber: number;
}>;

export class OutboxRecord {
	id?: string;
	aggregateId: string;
	aggregateType: string;
	eventType: string;
	payload: unknown;
	sequenceNumber: number;
	createdAt?: Date;
	processedAt?: Date;
	status: OutboxStatus;
	attempts: number;

	constructor({
		aggregateId,
		aggregateType,
		eventType,
		payload,
		id,
		createdAt,
		processedAt,
		status = OutboxStatus.PENDING,
		sequenceNumber = 0,
		attempts = 0,
	}: OutboxConstructor) {
		this.id = id;
		this.aggregateId = aggregateId;
		this.aggregateType = aggregateType;
		this.eventType = eventType;
		this.payload = payload;
		this.createdAt = createdAt ? new Date(createdAt) : new Date();
		this.processedAt = processedAt ? new Date(processedAt) : undefined;
		this.status = status;
		this.sequenceNumber = sequenceNumber;
		this.attempts = attempts;
	}
}
