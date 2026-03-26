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

COPY publisher.example.yaml ./publisher.yaml

EXPOSE 4599
EXPOSE 9464

CMD ["bun", "packages/core/src/app.ts"]
