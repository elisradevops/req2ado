# orchestrator/Dockerfile
FROM node:22-alpine
WORKDIR /app
# Prisma's query/schema engine needs libssl to select the correct binary
# target at `prisma generate` time. node:22-alpine ships without OpenSSL, so
# without this Prisma silently defaults to the wrong (openssl-1.1.x) engine
# binary and fails at runtime with "Error loading shared library libssl.so.1.1".
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json* ./
COPY src ./src
COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
