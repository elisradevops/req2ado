# mcp-ado-server/Dockerfile
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN mkdir -p .req2ado
EXPOSE 4100
CMD ["node", "dist/index.js"]
