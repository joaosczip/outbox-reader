import { PrismaClient } from "@prisma/client";
import { OutboxClient } from "@joaosczip/outy-client";
import { PrismaAdapter } from "@joaosczip/outy-client/prisma";

const prisma = new PrismaClient();

// PrismaAdapter takes no PrismaClient — it writes through the transaction
// client passed to `outbox.create()`. The options are optional and must match
// `outy create migration --table-name/--column-naming` and core's
// TABLE_NAME/COLUMN_NAMING (defaults: "outbox" / "snake_case").
const outbox = new OutboxClient(new PrismaAdapter({ tableName: "outbox", columnNaming: "snake_case" }));

/**
 * Creates an order and records an outbox event atomically.
 *
 * Both the `order` insert and the `outbox` insert run inside the same
 * Prisma interactive transaction, so either both are committed or neither
 * is — no dual-write risk.
 */
export async function createOrder(data: { customerId: string }) {
	return prisma.$transaction(async (tx) => {
		// 1. Write your domain record as usual.
		const order = await tx.order.create({
			data: { customerId: data.customerId },
		});

		// 2. Write the outbox event in the same transaction. Pass `tx` directly
		//    (or `{ underlying: tx }`). The returned id is a generated UUIDv7.
		const eventId = await outbox.create(
			{
				aggregateId: order.id, // id of the affected domain object
				aggregateType: "Order", // domain entity name
				eventType: "order.created", // event name (used as the NATS subject)
				payload: order, // JSON-serialisable data
			},
			tx,
		);

		return { order, eventId };
	});
}

/**
 * Producer-side idempotency: pass your own UUID as `id`. Retrying with the same
 * id fails on the primary key instead of emitting a second event.
 */
export async function shipOrder(orderId: string, shipmentId: string) {
	return prisma.$transaction(async (tx) => {
		await tx.order.update({ where: { id: orderId }, data: { shippedAt: new Date() } });

		await outbox.create(
			{
				id: shipmentId, // a UUID you already own (e.g. from the request)
				aggregateId: orderId,
				aggregateType: "Order",
				eventType: "order.shipped",
				payload: { orderId, shipmentId },
			},
			tx,
		);
	});
}
