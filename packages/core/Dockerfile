FROM oven/bun:1.2-alpine

WORKDIR /app

# Copy workspace manifests for dependency installation
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/

# Install production dependencies only
RUN bun install --production --frozen-lockfile

# Copy core source only
COPY packages/core/src ./packages/core/src

# No publisher.yaml is baked into the image. Configure the publisher either:
#   - from the environment only: NATS_SERVERS + NATS_SUBJECT_PREFIX (optionally NATS_USER,
#     NATS_PASSWORD, NATS_TOKEN, NATS_CONNECTION_NAME); used when the file below does not exist, or
#   - by mounting a yaml (see publisher.example.yaml) at PUBLISHER_CONFIG_PATH; NATS_* env vars
#     still override its options.
ENV PUBLISHER_CONFIG_PATH=/app/publisher.yaml

EXPOSE 4599
EXPOSE 9464

# Service by default. Cronjobs run from the same image, e.g.:
#   docker run --rm <image> bun packages/core/src/cronjobs/check-pending-events.ts
CMD ["bun", "packages/core/src/app.ts"]
