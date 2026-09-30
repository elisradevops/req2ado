# frontend/Dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Overwrite the dev placeholder (public/config.json has "http://localhost:3001")
# with the correct production default. The entrypoint script (40-req2ado-config.sh)
# overrides this at runtime when the filesystem is writable (docker-compose),
# but falls back to this baked value on k8s where readOnlyRootFilesystem is active.
RUN echo '{"apiBaseUrl":"/api"}' > /usr/share/nginx/html/config.json
# Templated, not static -- rendered by the base image's own
# /docker-entrypoint.d/20-envsubst-on-templates.sh on every container
# start, so the orchestrator upstream is env-driven (see the template's
# own header comment for why: 127.0.0.1 in the consolidated k8s pod,
# `orchestrator` in docker-compose).
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV UPSTREAM_HOST=127.0.0.1 \
    UPSTREAM_PORT=3001 \
    API_BASE_URL=/api
# Writes /usr/share/nginx/html/config.json from API_BASE_URL on every
# start -- see the script's own header comment for the defect this fixes.
COPY docker-entrypoint.d/40-req2ado-config.sh /docker-entrypoint.d/40-req2ado-config.sh
EXPOSE 80
