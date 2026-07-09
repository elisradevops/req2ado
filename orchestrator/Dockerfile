# orchestrator/Dockerfile
# Build context is the REPO ROOT (see docker-compose.yml), not this
# directory — needed so this Dockerfile can also COPY the root docs/ folder,
# which WikiController reads from at runtime via a relative path that
# resolves to container-root /docs (four levels up from dist/modules/wiki/).
FROM node:22-alpine
WORKDIR /app
# Prisma's query/schema engine needs libssl to select the correct binary
# target at `prisma generate` time. node:22-alpine ships without OpenSSL, so
# without this Prisma silently defaults to the wrong (openssl-1.1.x) engine
# binary and fails at runtime with "Error loading shared library libssl.so.1.1".
RUN apk add --no-cache openssl
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci
COPY orchestrator/tsconfig.json orchestrator/tsconfig.build.json orchestrator/nest-cli.json* ./
COPY orchestrator/src ./src
COPY orchestrator/prisma ./prisma
RUN npx prisma generate
RUN npm run build
# WikiController.getUserGuide reads from container-root /docs, not /app/docs
# — see its own comment ("four levels up") for why.
COPY docs /docs
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
