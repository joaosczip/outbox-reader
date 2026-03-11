# Containers fundamentals (`testcontainers` core)

Source:
- https://node.testcontainers.org/features/containers/

This reference covers base lifecycle and configuration primitives used by all module containers.

## Start, use, stop

```ts
import { GenericContainer } from "testcontainers";

const container = await new GenericContainer("alpine:3.20")
  .withCommand(["sleep", "infinity"])
  .start();

const result = await container.exec(["echo", "hello"]);
expect(result.exitCode).toBe(0);
expect(result.output.trim()).toBe("hello");

await container.stop();
```

## Environment + exposed port

```ts
const container = await new GenericContainer("nginx:1.27-alpine")
  .withEnvironment({ NGINX_HOST: "localhost" })
  .withExposedPorts(80)
  .start();

const host = container.getHost();
const port = container.getMappedPort(80);
```

## Copy files and stream logs

```ts
const container = await new GenericContainer("alpine:3.20")
  .withCopyContentToContainer([{ content: "hello", target: "/tmp/hello.txt" }])
  .withCommand(["sh", "-c", "cat /tmp/hello.txt && sleep 1"])
  .start();

const stream = await container.logs();
stream.on("data", (line) => {
  // inspect startup output while debugging
});

await container.stop();
```

## Guidance

- Use typed modules first; use `GenericContainer` for unsupported services or sidecars.
- Keep teardown explicit in `afterAll`.
- Avoid fixed host-port mappings unless unavoidable.

## Jest suite example

```ts
import { GenericContainer, StartedTestContainer } from "testcontainers";

describe("containers fundamentals", () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer("alpine:3.20")
      .withCommand(["sleep", "infinity"])
      .start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("runs a command inside the container", async () => {
    const result = await container.exec(["echo", "ok"]);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("ok");
  });
});
```
