# mcp-ado-server/Dockerfile
#
# Multi-stage build, non-root runtime user -- previously single-stage,
# shipping the native-module build toolchain (python3/make/g++, needed for
# better-sqlite3's compile step) and running as root in the final image.
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Prunes devDependencies from the SAME node_modules better-sqlite3 was just
# compiled into -- safer than re-running `npm ci --omit=dev` in a toolchain-
# less runtime stage and gambling on better-sqlite3's prebuild-install
# fetching a compatible prebuilt musl-libc binary (not guaranteed for every
# version/arch); this way the already-verified-working compiled binary is
# what actually ships.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
RUN mkdir -p .req2ado && chown -R node:node /app
USER node
EXPOSE 4100
CMD ["node", "dist/index.js"]
