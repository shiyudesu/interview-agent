# syntax=docker/dockerfile:1.7

FROM node:24.19.0-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json

RUN pnpm install \
    --filter=@interview-agent/server... \
    --frozen-lockfile \
    --fetch-retries=5 \
    --fetch-timeout=300000 \
    --network-concurrency=16

FROM dependencies AS build

COPY tsconfig.base.json ./
COPY apps/server ./apps/server
COPY packages ./packages

RUN pnpm --filter=@interview-agent/server... run build
RUN pnpm --filter=@interview-agent/server --prod deploy /app/deploy

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /app/deploy ./

USER node

EXPOSE 3000

STOPSIGNAL SIGTERM

CMD ["node", "dist/main.js"]
