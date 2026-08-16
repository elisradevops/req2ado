#!/usr/bin/env bash
# scripts/rebuild-app-services.sh — rebuilds and restarts every app-owned
# docker compose service (i.e. everything built from this repo's own
# source, excluding third-party images like postgres/redis/chroma).
#
# Why this exists: `migrate` and `orchestrator`/`pipeline-worker` share the
# SAME Dockerfile (orchestrator/Dockerfile) but are separate compose
# services with separate cached images. Rebuilding `orchestrator` alone
# does NOT rebuild `migrate`'s image -- if you forget it, `migrate` silently
# runs `prisma migrate deploy` against a STALE copy of prisma/migrations/,
# reports "No pending migrations to apply" (which is true FOR THAT STALE
# IMAGE, not for the real migration set), and the newly-rebuilt orchestrator
# then crashes on the first query touching a column that migration would
# have added. This exact failure happened once (see the SDD ledger under
# "Final E2E validation kickoff") and cost real debugging time to root-cause.
#
# Always rebuild the whole set together via this script rather than listing
# services by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

# migrate MUST run (via `docker compose up -d`, not just `build`) before
# orchestrator/pipeline-worker start, so the schema is current when they
# connect -- `docker compose up -d` respects the `depends_on:
# service_completed_successfully` ordering already declared for
# orchestrator in docker-compose.yml, so a plain `up -d` after building
# is sufficient; no separate manual `run migrate` step is needed here.
echo "Building: ingestion frontend orchestrator pipeline-worker migrate"
docker compose build ingestion frontend orchestrator pipeline-worker migrate

echo "Restarting with the new images (migrate runs its deploy step first)..."
docker compose up -d ingestion frontend orchestrator pipeline-worker

echo "Done. Check status: docker compose ps"
