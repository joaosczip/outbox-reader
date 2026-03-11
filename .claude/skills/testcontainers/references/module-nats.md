# NATS module (`@testcontainers/nats`)

Source:
- https://node.testcontainers.org/modules/nats/

Use this module for pub/sub and event-driven integration tests with NATS.

## Install

```bash
npm install --save-dev @testcontainers/nats
npm install @nats-io/transport-node
```

## Publish and consume one message

```ts
import { NatsContainer } from "@testcontainers/nats";
import { connect } from "@nats-io/transport-node";

const nats = await new NatsContainer("nats:2.10").start();
const nc = await connect(nats.getConnectionOptions());

const subject = "orders.created";
const payload = "event-1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sub = nc.subscribe(subject, { max: 1 });
nc.publish(subject, encoder.encode(payload));

for await (const message of sub) {
  expect(decoder.decode(message.data)).toBe(payload);
}

await nc.drain();
await nc.close();
await nats.stop();
```

## JetStream-enabled container

```ts
const nats = await new NatsContainer("nats:2.10").withJetStream().start();
```

## Notes

- Use `withJetStream()` when your app depends on streams/consumer state.
- Keep subject names explicit in tests to avoid accidental cross-suite coupling.

## Jest suite example

```ts
import { NatsContainer, StartedNatsContainer } from "@testcontainers/nats";
import { NatsConnection, connect } from "@nats-io/transport-node";

describe("nats integration", () => {
  let nats: StartedNatsContainer;
  let nc: NatsConnection;

  beforeAll(async () => {
    nats = await new NatsContainer("nats:2.10").start();
    nc = await connect(nats.getConnectionOptions());
  });

  afterAll(async () => {
    await nc?.drain();
    await nc?.close();
    await nats?.stop();
  });

  it("publishes and consumes one event", async () => {
    const subject = "suite.events";
    const payload = "payload-1";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const sub = nc.subscribe(subject, { max: 1 });
    nc.publish(subject, encoder.encode(payload));

    for await (const message of sub) {
      expect(decoder.decode(message.data)).toBe(payload);
    }
  });
});
```
