# orchestrator/Dockerfile
#
# Build context is the REPO ROOT (see docker-compose.yml), not this
# directory — needed so this Dockerfile can also COPY the root docs/ folder,
# which WikiController reads from at runtime via a relative path that
# resolves to container-root /docs (four levels up from dist/modules/wiki/).
#
# Multi-stage build, non-root runtime user -- previously single-stage,
# shipping the full dev toolchain (typescript, jest, eslint, etc.) and
# running as root in the final image. The runtime stage below only carries
# production dependencies, compiled dist/, and the generated Prisma client.
FROM node:22-alpine AS builder
WORKDIR /app
# Prisma's query/schema engine needs libssl to select the correct binary
# target at `prisma generate` time. node:22-alpine ships without OpenSSL, so
# without this Prisma silently defaults to the wrong (openssl-1.1.x) engine
# binary and fails at runtime with "Error loading shared library libssl.so.1.1".
RUN apk add --no-cache openssl
# Optional, empty by default -- a developer on a network with TLS-
# intercepting middleware (e.g. a corporate proxy) can supply an extra
# trusted CA certificate for THIS build only, via docker-compose.override.yml
# (gitignored, never committed -- see .gitignore). `prisma generate` below
# makes its own outbound HTTPS fetch (the query-engine binary from
# binaries.prisma.sh); with no cert supplied, this file is empty and
# NODE_EXTRA_CA_CERTS resolves to zero extra certs, i.e. Node's own default
# trust store, unchanged from before this existed.
ARG EXTRA_CA_CERT=""
RUN printf '%s' "$EXTRA_CA_CERT" > /tmp/extra-ca.pem
ENV NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem
# @req2ado/shared-ts (S10's codegen'd TS types, orchestrator/package.json's
# only cross-package dependency) is referenced as `file:../shared/ts` --
# pnpm's `workspace:*` protocol (the idiomatic monorepo spec) is NOT
# understood by plain `npm ci`, which is what this Dockerfile uses (a
# per-service package-lock.json, not the root pnpm-lock.yaml). `file:` is
# the one protocol both pnpm (local dev) and npm (this build) resolve the
# same way, so package.json only needs ONE dependency spec for both. Must
# land at /shared/ts so `../shared/ts` (relative to package.json's own
# /app location) resolves correctly -- same relative layout as the real
# repo (orchestrator/ and shared/ts/ are siblings).
COPY shared/ts /shared/ts
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci
COPY orchestrator/tsconfig.json orchestrator/tsconfig.build.json orchestrator/nest-cli.json* ./
COPY orchestrator/src ./src
COPY orchestrator/prisma ./prisma
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci --omit=dev
# The generated Prisma client (node_modules/.prisma/client) is produced by
# `prisma generate` in the builder stage, keyed to that stage's full
# node_modules -- copying it over the fresh prod-only install here rather
# than re-running `prisma generate` against a devDependency-less
# node_modules (which would fail: the `prisma` CLI package is itself a
# devDependency).
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# WikiController.getUserGuide reads from container-root /docs, not /app/docs
# — see its own comment ("four levels up") for why.
COPY docs /docs
# Alpine's node image already ships an unprivileged `node` user/group
# (uid/gid 1000) -- reuse it rather than defining a new one.
RUN chown -R node:node /app
USER node
EXPOSE 3001
# Exec-form, running node directly as PID 1 -- previously
# `["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]`, a
# shell-form CMD that (a) raced under multiple replicas/rolling updates
# running migrations concurrently, and (b) made `sh`, not `node`, PID 1, so
# SIGTERM was never reliably forwarded to the actual Node process at all --
# graceful shutdown hooks never fired in practice. Migrations now run as
# their own step (see docker-compose.yml's `migrate` service / this image's
# intended k8s initContainer usage) before this container ever starts.
CMD ["node", "dist/main.js"]
