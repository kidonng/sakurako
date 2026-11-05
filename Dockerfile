# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4-slim AS base
WORKDIR /app

# Install production dependencies into a separate layer for caching
FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production --ignore-scripts

# Final runtime image
FROM base AS release
ENV NODE_ENV=production

# Copy production node_modules from install stage
COPY --from=install /temp/prod/node_modules node_modules

# Copy application configuration and source code
COPY package.json tsconfig.json ./
COPY src/ src/
COPY assets/ assets/

# Ensure data directory exists and set ownership to unprivileged user
RUN mkdir -p /app/data && chown -R bun:bun /app

USER bun
VOLUME ["/app/data"]

ENTRYPOINT ["bun", "src/index.ts"]
