import type { Logger } from "../src/logger";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { OutboxProcessor } from "../src/outbox-processor";
import type { OutboxRepository } from "../src/outbox-repository";
import { MockLogger } from "./mocks/mock-logger";
import { MockOutboxRepository } from "./mocks/mock-outbox-repository";
import { MockPublisher } from "./mocks/mock-publisher";
import { Wal2JsonTestHelper } from "./mocks/wal2json-helper";

describe("OutboxProcessor", () => {
	let processor: OutboxProcessor;
	let mockRepository: MockOutboxRepository;
	let mockPublisher: MockPublisher;
	let mockLogger: MockLogger;

	beforeEach(() => {
		mockRepository = new MockOutboxRepository();
		mockPublisher = new MockPublisher();
		mockLogger = new MockLogger();

		processor = new OutboxProcessor({
			outboxRepository: mockRepository as unknown as OutboxRepository,
			logger: mockLogger as unknown as Logger,
			maxAttempts: 3,
		});
	});

	describe("processInserts", () => {
		describe("successful processing", () => {
			it("should successfully process a pending outbox record", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "test-id-1",
					aggregateId: "user-123",
					aggregateType: "User",
					eventType: "user.created",
					payload: { name: "John Doe" },
					status: OutboxStatus.PENDING,
					attempts: 0,
				});

				mockRepository.addRecord(record);
				mockPublisher.setSequenceNumber(54321);

				// Act
				await processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockRepository.findUnprocessedByIdCalls).toContain("test-id-1");
				expect(mockPublisher.publishedRecords).toHaveLength(1);
				expect(mockPublisher.publishedRecords[0].id).toBe("test-id-1");
				expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
				expect(mockRepository.markAsProcessedCalls[0]).toEqual({
					id: "test-id-1",
					sequenceNumber: 54321,
					attempts: 0,
				});
			});

			it("should process record with existing attempts", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "test-id-retry",
					aggregateId: "user-456",
					aggregateType: "User",
					eventType: "user.updated",
					payload: { name: "Jane Doe" },
					status: OutboxStatus.PENDING,
					attempts: 2,
				});

				mockRepository.addRecord(record);

				// Act
				await processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockRepository.markAsProcessedCalls[0].attempts).toBe(2);
				expect(mockPublisher.publishedRecords).toHaveLength(1);
			});
		});

		describe("record validation and filtering", () => {
			it("should skip processing if record is not found in repository", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "non-existent-id",
					aggregateId: "user-999",
					aggregateType: "User",
					eventType: "user.deleted",
					payload: {},
					status: OutboxStatus.PENDING,
					attempts: 0,
				});

				// Act (record is not added to repository)
				await processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockPublisher.publishedRecords).toHaveLength(0);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(0);
				expect(mockRepository.markAsFailedCalls).toHaveLength(0);
			});

			it("should skip processing if record is already processed", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "processed-id",
					aggregateId: "user-789",
					aggregateType: "User",
					eventType: "user.updated",
					payload: { name: "Already Processed" },
					status: OutboxStatus.PROCESSED,
					attempts: 1,
				});

				mockRepository.addRecord(record);

				// Act
				await processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockPublisher.publishedRecords).toHaveLength(0);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(0);
				expect(mockRepository.markAsFailedCalls).toHaveLength(0);
			});

			it("should skip processing if record has reached maximum attempts", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "max-attempts-id",
					aggregateId: "user-555",
					aggregateType: "User",
					eventType: "user.created",
					payload: { name: "Max Attempts" },
					status: OutboxStatus.PENDING,
					attempts: 5, // More than processor maxAttempts (3)
				});

				mockRepository.addRecord(record);

				// Act
				await processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockPublisher.publishedRecords).toHaveLength(0);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(0);
				expect(mockRepository.markAsFailedCalls).toHaveLength(0);
			});

			it("should skip processing when attempts equal maximum attempts", async () => {
				// Arrange - Since the condition is >= numOfAttempts, attempts equal to max should be skipped
				const record = new OutboxRecord({
					id: "exact-max-id",
					aggregateId: "user-333",
					aggregateType: "User",
					eventType: "user.created",
					payload: { name: "Exact Max" },
					status: OutboxStatus.PENDING,
					attempts: 3, // Equal to processor maxAttempts
				});

				mockRepository.addRecord(record);

				// Act
				await processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockPublisher.publishedRecords).toHaveLength(0);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(0);
			});

			it("should allow processing when attempts are below maximum", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "below-max-id",
					aggregateId: "user-444",
					aggregateType: "User",
					eventType: "user.created",
					payload: { name: "Below Max" },
					status: OutboxStatus.PENDING,
					attempts: 2, // Less than publisher's max attempts (3)
				});

				mockRepository.addRecord(record);

				// Act
				await processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockPublisher.publishedRecords).toHaveLength(1);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
			});
		});

		describe("error handling", () => {
			it("should throw when publisher fails", async () => {
				const record = new OutboxRecord({
					id: "fail-id",
					aggregateId: "user-111",
					aggregateType: "User",
					eventType: "user.created",
					payload: { name: "Fail Test" },
					status: OutboxStatus.PENDING,
					attempts: 1,
				});
				mockRepository.addRecord(record);
				mockPublisher.setError(new Error("Network failure"));

				await expect(
					processor.processInserts({ insertedRecord: record, publisher: mockPublisher }),
				).rejects.toThrow("Network failure");

				expect(mockRepository.markAsFailedCalls).toHaveLength(0);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(0);
			});

			it("should propagate different types of publisher errors", async () => {
				const record = new OutboxRecord({
					id: "timeout-id",
					aggregateId: "user-222",
					aggregateType: "User",
					eventType: "user.created",
					payload: { name: "Timeout Test" },
					status: OutboxStatus.PENDING,
					attempts: 0,
				});
				mockRepository.addRecord(record);
				mockPublisher.setError(new Error("Connection timeout"));

				await expect(
					processor.processInserts({ insertedRecord: record, publisher: mockPublisher }),
				).rejects.toThrow("Connection timeout");
			});
		});

		describe("prefetched outbox (batch path)", () => {
			it("should use prefetchedOutbox and skip the repository read", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "prefetch-id",
					aggregateId: "user-123",
					aggregateType: "User",
					eventType: "user.created",
					payload: { name: "John" },
					status: OutboxStatus.PENDING,
					attempts: 0,
				});

				// Act — pass the record as prefetchedOutbox, NOT added to mock repository
				await processor.processInserts({
					insertedRecord: record,
					prefetchedOutbox: record as never,
					publisher: mockPublisher,
				});

				// Assert — no individual DB read was issued
				expect(mockRepository.findUnprocessedByIdCalls).toHaveLength(0);
				expect(mockPublisher.publishedRecords).toHaveLength(1);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
			});

			it("should skip publish when prefetchedOutbox is null (record not in DB)", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "not-found-id",
					aggregateId: "user-999",
					aggregateType: "User",
					eventType: "user.created",
					payload: {},
					status: OutboxStatus.PENDING,
					attempts: 0,
				});

				// Act — null means the batch fetch found no matching row
				await processor.processInserts({
					insertedRecord: record,
					prefetchedOutbox: null,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockRepository.findUnprocessedByIdCalls).toHaveLength(0);
				expect(mockPublisher.publishedRecords).toHaveLength(0);
				expect(mockRepository.markAsProcessedCalls).toHaveLength(0);
				expect(mockRepository.markAsFailedCalls).toHaveLength(0);
			});

			it("should skip publish when prefetchedOutbox has PROCESSED status", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "already-done-id",
					aggregateId: "user-321",
					aggregateType: "User",
					eventType: "user.updated",
					payload: {},
					status: OutboxStatus.PROCESSED,
					attempts: 1,
				});

				// Act
				await processor.processInserts({
					insertedRecord: record,
					prefetchedOutbox: record as never,
					publisher: mockPublisher,
				});

				// Assert
				expect(mockRepository.findUnprocessedByIdCalls).toHaveLength(0);
				expect(mockPublisher.publishedRecords).toHaveLength(0);
			});

			it("should throw on publish error when using prefetchedOutbox", async () => {
				// Arrange
				const record = new OutboxRecord({
					id: "prefetch-fail-id",
					aggregateId: "user-fail",
					aggregateType: "User",
					eventType: "user.created",
					payload: {},
					status: OutboxStatus.PENDING,
					attempts: 0,
				});

				mockPublisher.setError(new Error("NATS unavailable"));

				// Act & Assert
				await expect(
					processor.processInserts({
						insertedRecord: record,
						prefetchedOutbox: record as never,
						publisher: mockPublisher,
					}),
				).rejects.toThrow("NATS unavailable");

				expect(mockRepository.findUnprocessedByIdCalls).toHaveLength(0);
				expect(mockRepository.markAsFailedCalls).toHaveLength(0);
			});
		});

		describe("publish call shape", () => {
			it("should call publisher with only the outbox record", async () => {
				const record = new OutboxRecord({
					id: "shape-test-id",
					aggregateId: "user-shape",
					aggregateType: "User",
					eventType: "user.created",
					payload: {},
					status: OutboxStatus.PENDING,
					attempts: 0,
				});
				mockRepository.addRecord(record);

				await processor.processInserts({ insertedRecord: record, publisher: mockPublisher });

				expect(mockPublisher.publishCalls).toHaveLength(1);
				expect(mockPublisher.publishCalls[0].record.id).toBe("shape-test-id");
			});

			it("should not call markAsFailed on success", async () => {
				const record = new OutboxRecord({
					id: "success-id",
					aggregateId: "user-ok",
					aggregateType: "User",
					eventType: "user.created",
					payload: {},
					status: OutboxStatus.PENDING,
					attempts: 0,
				});
				mockRepository.addRecord(record);

				await processor.processInserts({ insertedRecord: record, publisher: mockPublisher });

				expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
				expect(mockRepository.markAsFailedCalls).toHaveLength(0);
			});
		});
	});

	describe("filterChanges", () => {
		describe("change filtering", () => {
			it("should filter and transform outbox insert changes correctly", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					Wal2JsonTestHelper.createOutboxInsert({
						id: "test-id-1",
						aggregateId: "user-123",
						aggregateType: "User",
						eventType: "user.created",
						payload: '{"name":"John"}',
						status: "PENDING",
						attempts: 0,
					}),
					{
						kind: "insert",
						table: "other_table",
						columnnames: ["id", "name"],
						columnvalues: ["other-id", "other-name"],
					},
					{
						kind: "update",
						table: "outbox",
						columnnames: ["id", "status"],
						columnvalues: ["test-id-2", "PROCESSED"],
					},
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(1);
				expect(result[0]).toBeInstanceOf(OutboxRecord);
				expect(result[0].id).toBe("test-id-1");
				expect(result[0].aggregateId).toBe("user-123");
				expect(result[0].aggregateType).toBe("User");
				expect(result[0].eventType).toBe("user.created");
				expect(result[0].payload).toBe('{"name":"John"}');
				expect(result[0].status).toBe("PENDING");
				expect(result[0].attempts).toBe(0);
			});

			it("should handle empty change log", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(0);
			});

			it("should filter out non-outbox table changes", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					{
						kind: "insert",
						table: "users",
						columnnames: ["id", "name"],
						columnvalues: ["user-1", "John"],
					},
					{
						kind: "insert",
						table: "orders",
						columnnames: ["id", "total"],
						columnvalues: ["order-1", "100.00"],
					},
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(0);
			});

			it("should filter out non-insert operations on outbox table", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					{
						kind: "update",
						table: "outbox",
						columnnames: ["id", "status"],
						columnvalues: ["test-id-1", "PROCESSED"],
					},
					{
						kind: "delete",
						table: "outbox",
						columnnames: ["id"],
						columnvalues: ["test-id-2"],
					},
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(0);
			});

			it("should require columnnames to be present", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					{
						kind: "insert",
						table: "outbox",
						columnnames: [], // Empty columnnames should be filtered out
						columnvalues: ["test-id-1", "user-123"],
					},
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(0);
			});
		});

		describe("column mapping", () => {
			it("should handle column name mapping correctly", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					Wal2JsonTestHelper.createOutboxInsert({
						id: "mapping-test",
						aggregateId: "agg-123",
						aggregateType: "AggType",
						eventType: "event.type",
						createdAt: "2023-01-01",
						processedAt: null,
					}),
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(1);
				expect(result[0].aggregateId).toBe("agg-123");
				expect(result[0].aggregateType).toBe("AggType");
				expect(result[0].eventType).toBe("event.type");
				expect(result[0].createdAt).toEqual(new Date("2023-01-01"));
				expect(result[0].processedAt).toBeUndefined();
			});

			it("should handle all standard outbox columns", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					Wal2JsonTestHelper.createOutboxInsert({
						id: "full-test",
						aggregateId: "full-agg",
						aggregateType: "FullType",
						eventType: "full.event",
						payload: '{"complete":true}',
						status: "PENDING",
						attempts: 2,
						createdAt: "2023-12-01 10:30:00",
						processedAt: "2023-12-01 10:35:00",
						sequenceNumber: 999,
					}),
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(1);
				const record = result[0];
				expect(record.id).toBe("full-test");
				expect(record.aggregateId).toBe("full-agg");
				expect(record.aggregateType).toBe("FullType");
				expect(record.eventType).toBe("full.event");
				expect(record.payload).toBe('{"complete":true}');
				expect(record.status).toBe("PENDING");
				expect(record.attempts).toBe(2);
				expect(record.createdAt).toEqual(new Date("2023-12-01 10:30:00"));
				expect(record.processedAt).toEqual(new Date("2023-12-01 10:35:00"));
				expect(record.sequenceNumber).toBe(999);
			});

			it("should handle partial column sets", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					{
						kind: "insert",
						table: "outbox",
						columnnames: ["id", "aggregate_id", "event_type"],
						columnvalues: ["partial-id", "partial-agg", "partial.event"],
					},
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(1);
				expect(result[0].id).toBe("partial-id");
				expect(result[0].aggregateId).toBe("partial-agg");
				expect(result[0].eventType).toBe("partial.event");
			});
		});

		describe("multiple records processing", () => {
			it("should process multiple valid outbox inserts", () => {
				// Arrange
				const walOutput = Wal2JsonTestHelper.createMockOutput([
					Wal2JsonTestHelper.createOutboxInsert({
						id: "multi-1",
						aggregateId: "agg-1",
						aggregateType: "Type1",
						eventType: "event.1",
					}),
					Wal2JsonTestHelper.createOutboxInsert({
						id: "multi-2",
						aggregateId: "agg-2",
						aggregateType: "Type2",
						eventType: "event.2",
					}),
					{
						kind: "insert",
						table: "other_table",
						columnnames: ["id"],
						columnvalues: ["should-be-filtered"],
					},
				]);

				// Act
				const result = processor.filterChanges(walOutput);

				// Assert
				expect(result).toHaveLength(2);
				expect(result[0].id).toBe("multi-1");
				expect(result[1].id).toBe("multi-2");
			});
		});
	});

	describe("integration scenarios", () => {
		it("should handle complete flow with publish and status update", async () => {
			// Arrange
			const record = new OutboxRecord({
				id: "integration-test",
				aggregateId: "user-integration",
				aggregateType: "User",
				eventType: "user.created",
				payload: { name: "Integration Test", email: "test@example.com" },
				status: OutboxStatus.PENDING,
				attempts: 1,
			});

			mockRepository.addRecord(record);
			mockPublisher.setSequenceNumber(98765);

			// Act
			await processor.processInserts({
				insertedRecord: record,
				publisher: mockPublisher,
			});

			// Assert - Verify complete flow
			expect(mockRepository.findUnprocessedByIdCalls).toContain("integration-test");
			expect(mockPublisher.publishedRecords).toHaveLength(1);
			expect(mockPublisher.publishedRecords[0].payload).toEqual({
				name: "Integration Test",
				email: "test@example.com",
			});
			expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
			expect(mockRepository.markAsProcessedCalls[0]).toEqual({
				id: "integration-test",
				sequenceNumber: 98765,
				attempts: 1,
			});
		});

		it("should handle repository errors during markAsProcessed", async () => {
			// Arrange
			const record = new OutboxRecord({
				id: "repo-error-test",
				aggregateId: "user-repo-error",
				aggregateType: "User",
				eventType: "user.created",
				payload: { name: "Repo Error Test" },
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			mockRepository.addRecord(record);
			// Simulate repository error during markAsProcessed
			mockRepository.markAsProcessed = jest.fn().mockRejectedValue(new Error("Database connection lost"));

			// Act & Assert - error propagates since there is no try/catch in processInserts
			await expect(
				processor.processInserts({
					insertedRecord: record,
					publisher: mockPublisher,
				}),
			).rejects.toThrow("Database connection lost");

			// Published but failed to mark as processed
			expect(mockPublisher.publishedRecords).toHaveLength(1);
		});

		it("should process multiple different event types correctly", async () => {
			// Arrange
			const userCreatedRecord = new OutboxRecord({
				id: "user-created",
				aggregateId: "user-123",
				aggregateType: "User",
				eventType: "user.created",
				payload: { name: "John Doe" },
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			const orderPlacedRecord = new OutboxRecord({
				id: "order-placed",
				aggregateId: "order-456",
				aggregateType: "Order",
				eventType: "order.placed",
				payload: { total: 99.99, items: ["item1", "item2"] },
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			mockRepository.addRecord(userCreatedRecord);
			mockRepository.addRecord(orderPlacedRecord);

			// Act
			await processor.processInserts({
				insertedRecord: userCreatedRecord,
				publisher: mockPublisher,
			});

			await processor.processInserts({
				insertedRecord: orderPlacedRecord,
				publisher: mockPublisher,
			});

			// Assert
			expect(mockPublisher.publishedRecords).toHaveLength(2);
			expect(mockPublisher.publishedRecords[0].eventType).toBe("user.created");
			expect(mockPublisher.publishedRecords[1].eventType).toBe("order.placed");
			expect(mockRepository.markAsProcessedCalls).toHaveLength(2);
		});
	});

	describe("edge cases", () => {
		it("should handle null and undefined payload values", async () => {
			// Arrange
			const recordWithNullPayload = new OutboxRecord({
				id: "null-payload",
				aggregateId: "user-null",
				aggregateType: "User",
				eventType: "user.deleted",
				payload: null,
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			mockRepository.addRecord(recordWithNullPayload);

			// Act
			await processor.processInserts({
				insertedRecord: recordWithNullPayload,
				publisher: mockPublisher,
			});

			// Assert
			expect(mockPublisher.publishedRecords).toHaveLength(1);
			expect(mockPublisher.publishedRecords[0].payload).toBeNull();
			expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
		});

		it("should handle very large payloads", async () => {
			// Arrange
			const largePayload = {
				data: "x".repeat(10000), // Large string
				array: Array(1000)
					.fill(0)
					.map((_, i) => ({ id: i, value: `item-${i}` })),
			};

			const record = new OutboxRecord({
				id: "large-payload",
				aggregateId: "user-large",
				aggregateType: "User",
				eventType: "user.bulk_update",
				payload: largePayload,
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			mockRepository.addRecord(record);

			// Act
			await processor.processInserts({
				insertedRecord: record,
				publisher: mockPublisher,
			});

			// Assert
			expect(mockPublisher.publishedRecords).toHaveLength(1);
			expect(mockPublisher.publishedRecords[0].payload).toEqual(largePayload);
			expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
		});

		it("should handle special characters in IDs and event types", async () => {
			// Arrange
			const record = new OutboxRecord({
				id: "special-chars-123_$%#@",
				aggregateId: "user-special-äöü",
				aggregateType: "User",
				eventType: "user.special_event.with-dashes",
				payload: { message: "Special chars: äöü ñ 中文 🚀" },
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			mockRepository.addRecord(record);

			// Act
			await processor.processInserts({
				insertedRecord: record,
				publisher: mockPublisher,
			});

			// Assert
			expect(mockPublisher.publishedRecords).toHaveLength(1);
			expect(mockPublisher.publishedRecords[0].id).toBe("special-chars-123_$%#@");
			expect(mockPublisher.publishedRecords[0].aggregateId).toBe("user-special-äöü");
			expect(mockPublisher.publishedRecords[0].eventType).toBe("user.special_event.with-dashes");
			expect(mockRepository.markAsProcessedCalls).toHaveLength(1);
		});
	});

	describe("data type handling", () => {
		it("should handle numeric string values correctly", () => {
			// Arrange
			const walOutput = Wal2JsonTestHelper.createMockOutput([
				{
					kind: "insert",
					table: "outbox",
					columnnames: ["id", "aggregate_id", "event_type", "attempts", "sequence_number"],
					columnvalues: ["numeric-test", "user-123", "user.created", "5", "12345"], // String representations
				},
			]);

			// Act
			const result = processor.filterChanges(walOutput);

			// Assert
			expect(result).toHaveLength(1);
			expect(result[0].attempts).toBe("5");
			expect(result[0].sequenceNumber).toBe("12345");
		});

		it("should handle boolean string values", () => {
			// Arrange
			const walOutput = Wal2JsonTestHelper.createMockOutput([
				{
					kind: "insert",
					table: "outbox",
					columnnames: ["id", "aggregate_id", "event_type", "payload"],
					columnvalues: [
						"bool-test",
						"user-bool",
						"user.activated",
						'{"active": "true", "verified": "false"}',
					],
				},
			]);

			// Act
			const result = processor.filterChanges(walOutput);

			// Assert
			expect(result).toHaveLength(1);
			expect(result[0].payload).toBe('{"active": "true", "verified": "false"}');
		});

		it("should handle null values correctly", () => {
			// Arrange
			const walOutput = Wal2JsonTestHelper.createMockOutput([
				{
					kind: "insert",
					table: "outbox",
					columnnames: ["id", "aggregate_id", "event_type", "processed_at", "sequence_number"],
					columnvalues: ["null-test", "user-null", "user.created", null, null],
				},
			]);

			// Act
			const result = processor.filterChanges(walOutput);

			// Assert
			expect(result).toHaveLength(1);
			expect(result[0].processedAt).toBeUndefined();
			expect(result[0].sequenceNumber).toBeNull();
		});

		it("should handle empty string values", () => {
			// Arrange
			const walOutput = Wal2JsonTestHelper.createMockOutput([
				{
					kind: "insert",
					table: "outbox",
					columnnames: ["id", "aggregate_id", "event_type", "payload"],
					columnvalues: ["empty-test", "", "user.created", ""],
				},
			]);

			// Act
			const result = processor.filterChanges(walOutput);

			// Assert
			expect(result).toHaveLength(1);
			expect(result[0].aggregateId).toBe("");
			expect(result[0].payload).toBe("");
		});
	});

	describe("complex change log scenarios", () => {
		it("should handle mixed operations with proper filtering", () => {
			// Arrange
			const walOutput = Wal2JsonTestHelper.createMockOutput([
				// Valid outbox insert
				Wal2JsonTestHelper.createOutboxInsert({
					id: "valid-1",
					aggregateId: "user-1",
					aggregateType: "User",
					eventType: "user.created",
				}),
				// Update on outbox table (should be filtered out)
				{
					kind: "update",
					table: "outbox",
					columnnames: ["id", "status"],
					columnvalues: ["existing-id", "PROCESSED"],
				},
				// Insert on different table (should be filtered out)
				{
					kind: "insert",
					table: "users",
					columnnames: ["id", "name"],
					columnvalues: ["user-123", "John Doe"],
				},
				// Another valid outbox insert
				Wal2JsonTestHelper.createOutboxInsert({
					id: "valid-2",
					aggregateId: "order-1",
					aggregateType: "Order",
					eventType: "order.placed",
				}),
				// Delete on outbox table (should be filtered out)
				{
					kind: "delete",
					table: "outbox",
					columnnames: ["id"],
					columnvalues: ["deleted-id"],
				},
			]);

			// Act
			const result = processor.filterChanges(walOutput);

			// Assert
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe("valid-1");
			expect(result[1].id).toBe("valid-2");
		});

		it("should handle malformed changes gracefully", () => {
			// Arrange
			const walOutput = Wal2JsonTestHelper.createMockOutput([
				// Missing columnnames
				{
					kind: "insert",
					table: "outbox",
					columnnames: undefined as unknown as string[],
					columnvalues: ["test-id", "user-123"],
				},
				// Empty columnnames
				{
					kind: "insert",
					table: "outbox",
					columnnames: [],
					columnvalues: ["test-id-2", "user-456"],
				},
				// Valid change
				Wal2JsonTestHelper.createOutboxInsert({
					id: "valid-after-malformed",
					aggregateId: "user-valid",
					aggregateType: "User",
					eventType: "user.created",
				}),
			]);

			// Act
			const result = processor.filterChanges(walOutput);

			// Assert
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("valid-after-malformed");
		});

		it("should handle columns in different orders", () => {
			// Arrange
			const walOutput = Wal2JsonTestHelper.createMockOutput([
				{
					kind: "insert",
					table: "outbox",
					columnnames: ["event_type", "id", "aggregate_type", "aggregate_id", "attempts"],
					columnvalues: ["user.created", "reordered-test", "User", "user-reordered", 3],
				},
			]);

			// Act
			const result = processor.filterChanges(walOutput);

			// Assert
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("reordered-test");
			expect(result[0].aggregateId).toBe("user-reordered");
			expect(result[0].aggregateType).toBe("User");
			expect(result[0].eventType).toBe("user.created");
			expect(result[0].attempts).toBe(3);
		});
	});
});
