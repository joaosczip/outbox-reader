FROM oven/bun:1.2-alpine

WORKDIR /app

# Copy workspace manifests for dependency installation
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/

# Install production dependencies only
RUN bun install --production --frozen-lockfile

# Copy core source only
COPY packages/core/src ./packages/core/src

EXPOSE 4599

CMD ["bun", "packages/core/src/app.ts"]
