import { PrismaClient } from "@prisma/client";
import { OutboxClient } from "@outbox-reader/client";
import { PrismaAdapter } from "@outbox-reader/client/prisma";

const prisma = new PrismaClient();

// PrismaAdapter requires no constructor arguments — it uses the Prisma
// transaction client passed at call time via `outbox.create()`.
const outbox = new OutboxClient(new PrismaAdapter());

/**
 * Creates an order and records an outbox event atomically.
 *
 * Both the `order` insert and the `outbox` insert run inside the same
 * Prisma interactive transaction, so either both are committed or neither
 * is — guaranteeing at-least-once delivery without dual-write risk.
 */
async function createOrder(data: { customerId: string; items: unknown[] }) {
  return prisma.$transaction(async (tx) => {
    // 1. Write your domain record as usual.
    const order = await tx.order.create({
      data: { customerId: data.customerId },
    });

    // 2. Write the outbox event in the same transaction.
    //    `underlying` is the Prisma transaction client (`tx`), which
    //    implements `$executeRawUnsafe` used by the adapter internally.
    await outbox.create(
      {
        aggregateId: order.id,       // unique ID of the affected domain object
        aggregateType: "Order",      // domain entity name
        eventType: "order.created",  // event name (used as the NATS subject)
        payload: order,              // arbitrary data serialised to JSON
      },
      { underlying: tx },
    );

    return order;
  });
}
