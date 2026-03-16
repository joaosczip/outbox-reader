import { DataTypes, Model, Sequelize } from "sequelize";
import { OutboxClient } from "@outbox-reader/client";
import { SequelizeAdapter } from "@outbox-reader/client/sequelize";

const sequelize = new Sequelize(process.env.DATABASE_URL!);

// SequelizeAdapter requires the Sequelize instance so it can call
// `sequelize.query()` internally to insert the outbox row.
const outbox = new OutboxClient(new SequelizeAdapter(sequelize));

// Minimal Order model — replace with your real model definition.
class Order extends Model {
  declare id: number;
  declare customerId: string;
}

Order.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    customerId: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize, modelName: "Order" },
);

/**
 * Creates an order and records an outbox event atomically.
 *
 * Both the `order` insert and the `outbox` insert run inside the same
 * Sequelize managed transaction, so either both are committed or neither
 * is — guaranteeing at-least-once delivery without dual-write risk.
 */
async function createOrder(data: { customerId: string }) {
  return sequelize.transaction(async (t) => {
    // 1. Write your domain record as usual, passing the transaction.
    const order = await Order.create(
      { customerId: data.customerId },
      { transaction: t },
    );

    // 2. Write the outbox event in the same transaction.
    //    `underlying` is the Sequelize transaction object (`t`), which
    //    is forwarded to `sequelize.query()` by the adapter internally.
    await outbox.create(
      {
        aggregateId: String(order.id), // unique ID of the affected domain object
        aggregateType: "Order",        // domain entity name
        eventType: "order.created",    // event name (used as the NATS subject)
        payload: order.toJSON(),       // arbitrary data serialised to JSON
      },
      { underlying: t },
    );

    return order;
  });
}
