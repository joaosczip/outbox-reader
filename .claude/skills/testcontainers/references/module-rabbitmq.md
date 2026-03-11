# RabbitMQ module (`@testcontainers/rabbitmq`)

Source:
- https://node.testcontainers.org/modules/rabbitmq/

Use this module for queue-based messaging tests when application behavior depends on AMQP semantics.

## Install

```bash
npm install --save-dev @testcontainers/rabbitmq
npm install amqplib
npm install --save-dev @types/amqplib
```

## Publish and consume

```ts
import { RabbitMQContainer } from "@testcontainers/rabbitmq";
import amqp from "amqplib";

const rabbit = await new RabbitMQContainer("rabbitmq:3.13-management").start();

const connection = await amqp.connect(rabbit.getAmqpUrl());
const channel = await connection.createChannel();

const queue = "invoice-created";
const body = "msg-1";

await channel.assertQueue(queue, { durable: false });
channel.sendToQueue(queue, Buffer.from(body));

const consumed = await new Promise<string>((resolve) => {
  channel.consume(queue, (message) => {
    resolve(message?.content.toString() ?? "");
  }, { noAck: true });
});

expect(consumed).toBe(body);

await channel.close();
await connection.close();
await rabbit.stop();
```

## Custom credentials

```ts
const rabbit = await new RabbitMQContainer("rabbitmq:3.13-management")
  .withEnvironment({
    RABBITMQ_DEFAULT_USER: "test-user",
    RABBITMQ_DEFAULT_PASS: "test-pass",
  })
  .start();
```

## Notes

- Use non-durable test queues unless durability is the behavior under test.
- Keep queue names deterministic to simplify assertions and cleanup.

## Jest suite example

```ts
import { RabbitMQContainer, StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import amqp, { Channel, ChannelModel } from "amqplib";

describe("rabbitmq integration", () => {
  let rabbit: StartedRabbitMQContainer;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    rabbit = await new RabbitMQContainer("rabbitmq:3.13-management").start();
    connection = await amqp.connect(rabbit.getAmqpUrl());
    channel = await connection.createChannel();
  });

  afterAll(async () => {
    await channel?.close();
    await connection?.close();
    await rabbit?.stop();
  });

  it("publishes and consumes queue message", async () => {
    const queue = "suite-queue";
    const payload = "hello-rabbit";

    await channel.assertQueue(queue, { durable: false });
    channel.sendToQueue(queue, Buffer.from(payload));

    const consumed = await new Promise<string>((resolve) => {
      channel.consume(
        queue,
        (message) => resolve(message?.content.toString() ?? ""),
        { noAck: true }
      );
    });

    expect(consumed).toBe(payload);
  });
});
```
