process.env.LOG_LEVEL = "silent";

export const testConfig = {
	connectionString: process.env.TEST_DATABASE_URL ?? "postgres://root:root@localhost:5433/ecomm-be",
	natsUrl: process.env.TEST_NATS_URL ?? "nats://localhost:4222",
	replicationSlot: process.env.TEST_REPLICATION_SLOT_NAME ?? "outbox_slot_e2e_test",
	streamName: process.env.TEST_JETSTREAM_STREAM_NAME ?? "OUTBOX_E2E_TEST",
	testSubjectPrefix: "e2e.test.",
};
