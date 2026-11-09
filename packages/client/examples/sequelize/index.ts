import { OutboxClient } from "@joaosczip/outy-client";
import { SequelizeAdapter } from "@joaosczip/outy-client/sequelize";
import { DataTypes, Model, Sequelize } from "sequelize";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sequelize = new Sequelize(databaseUrl);

// SequelizeAdapter needs the Sequelize instance to run `sequelize.query()`.
// The options are optional and must match `outy create migration
// --table-name/--column-naming` and core's TABLE_NAME/COLUMN_NAMING.
// Here the table was created with `--table-name outbox_events --column-naming camelCase`,
// i.e. a table "outboxEvents" with columns "aggregateId", "eventType", ...
const outbox = new OutboxClient(
	new SequelizeAdapter(sequelize, { tableName: "outbox_events", columnNaming: "camelCase" }),
);

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
 * Both the `order` insert and the outbox insert run inside the same
 * Sequelize managed transaction, so either both are committed or neither
 * is — no dual-write risk.
 */
export async function createOrder(data: { customerId: string }) {
	return sequelize.transaction(async (t) => {
		// 1. Write your domain record as usual, passing the transaction.
		const order = await Order.create({ customerId: data.customerId }, { transaction: t });

		// 2. Write the outbox event in the same transaction. Pass `t` directly
		//    (or `{ underlying: t }`); the adapter forwards it to `sequelize.query()`.
		const eventId = await outbox.create(
			{
				aggregateId: String(order.id), // id of the affected domain object
				aggregateType: "Order", // domain entity name
				eventType: "order.created", // event name (used as the NATS subject)
				payload: order.toJSON(), // JSON-serialisable data
			},
			t,
		);

		return { order, eventId };
	});
}
