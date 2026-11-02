# syntax=docker/dockerfile:1
# One image for every service (init, simulators, seed, app); compose picks the command.

FROM node:22.15.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

FROM base AS build
# Toolchain only as a fallback in case no better-sqlite3 prebuild can be fetched for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
# Resilience against flaky registry/DNS: retry harder, compile native modules against the
# headers bundled in this image (no nodejs.org download), and keep a persistent pnpm store
# (cache mount) so a retried build does not re-download everything.
ENV npm_config_nodedir=/usr/local \
    npm_config_fetch_retries=6 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=300000 \
    npm_config_store_dir=/pnpm/store
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=leadrescue-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Production Mastra server with Studio; re-applies the @mastra/core fix to the build output.
RUN --mount=type=cache,id=leadrescue-pnpm,target=/pnpm/store pnpm build:mastra

FROM base AS runtime
ENV NODE_ENV=production
# Owned by the unprivileged runtime user (tools such as vitest write temp files next to their config).
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data /config && chown node:node /app/data /config
USER node
EXPOSE 4111 4200
CMD ["node", ".mastra/output/index.mjs"]
