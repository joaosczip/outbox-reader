# Images fundamentals (build and substitution)

Source:
- https://node.testcontainers.org/features/images/

Use image features when tests require a custom Dockerfile or private-registry mirroring.

## Build from Dockerfile and start

```ts
import { GenericContainer } from "testcontainers";

const built = await GenericContainer.fromDockerfile(".", "Dockerfile.test").build();
const container = await built.start();
await container.stop();
```

## Build with args and target stage

```ts
const built = await GenericContainer.fromDockerfile(".")
  .withBuildArgs({ NODE_ENV: "test" })
  .withTarget("runtime")
  .build("my-test-image", { deleteOnExit: false });
```

## Image name substitution (private mirror)

Set this environment variable in CI:

```bash
TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX=registry.mycompany.com/mirror/
```

With this set, Docker Hub pulls are rewritten to your mirror prefix.

## Guidance

- Keep image tags explicit and stable.
- Prefer prebuilt official module images unless custom behavior is required.

## Jest suite example

```ts
import { GenericContainer, StartedGenericContainer } from "testcontainers";

describe("images fundamentals", () => {
  let container: StartedGenericContainer;

  beforeAll(async () => {
    const built = await GenericContainer.fromDockerfile(
      "/absolute/path/to/fixtures/images",
      "Dockerfile.test"
    ).build("testcontainers-image-suite", { deleteOnExit: true });

    container = await built.start();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("starts the built image and executes a command", async () => {
    const result = await container.exec(["sh", "-c", "echo image-ready"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("image-ready");
  });
});
```
