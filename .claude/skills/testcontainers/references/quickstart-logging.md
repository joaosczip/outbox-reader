# Logging fundamentals

Source:
- https://node.testcontainers.org/quickstart/logging/

Testcontainers uses the `debug` logger. Enable logs only when troubleshooting to keep test output clean.

## Enable all logs

```bash
DEBUG=testcontainers* npm test -- test/app.e2e-spec.ts
```

## Enable focused namespaces

```bash
DEBUG=testcontainers,testcontainers:containers,testcontainers:exec npm test -- -t "creates a transaction"
```

## Common namespaces

- `testcontainers*`: all logs
- `testcontainers`: core runtime logs
- `testcontainers:containers`: container lifecycle
- `testcontainers:compose`: compose lifecycle
- `testcontainers:build`: Docker image build logs
- `testcontainers:pull`: image pull logs
- `testcontainers:exec`: in-container command execution

## Guidance

- Start with `testcontainers:containers` for startup failures.
- Add `testcontainers:pull` when CI fails on image pulls.

## Jest suite example

```ts
import { GenericContainer, StartedTestContainer } from "testcontainers";

describe("logging fundamentals", () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    process.env.DEBUG = "testcontainers:containers,testcontainers:exec";

    container = await new GenericContainer("alpine:3.20")
      .withCommand(["sleep", "infinity"])
      .start();
  });

  afterAll(async () => {
    await container?.stop();
    delete process.env.DEBUG;
  });

  it("executes a command while debug logs are enabled", async () => {
    const result = await container.exec(["echo", "debug-enabled"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("debug-enabled");
  });
});
```
