#!/bin/sh
# frontend/docker-entrypoint.d/40-req2ado-config.sh
#
# Runs automatically on container start -- the nginx:1.27-alpine base
# image's stock entrypoint executes every executable script under
# /docker-entrypoint.d/ (in filename order) before starting nginx. This is
# the officially supported extension point, so no custom ENTRYPOINT/CMD is
# needed here.
#
# Fixes a real defect: frontend/src/api/config.ts fetches /config.json at
# runtime with no fallback, but nothing was ever writing that file -- the
# image only ever shipped the build-time placeholder
# (frontend/public/config.json, "http://localhost:3001"), baked in and
# never overwritten. Every deployed environment silently pointed the
# browser at localhost.
set -eu

: "${API_BASE_URL:=/api}"

cat > /usr/share/nginx/html/config.json <<EOF
{"apiBaseUrl": "${API_BASE_URL}"}
EOF
