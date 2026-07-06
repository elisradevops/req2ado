#!/usr/bin/env bash
#
# Golden end-to-end script for req2ado (Phase 7.5, Task 7).
#
# Runs the REAL full pipeline (ingestion service, mcp-ado-server with
# ADO_BACKEND=mock, orchestrator HTTP API, orchestrator pipeline worker) as
# LOCAL PROCESSES rather than docker-compose. Drives: upload -> dry-run diff
# -> confirm -> re-run with the identical fixture and asserts the second
# run's diff is 100% reuse (proving idempotent re-run, the actual golden-path
# assertion).
#
# All processes/containers this script itself starts are torn down in the
# EXIT trap, on both success and failure.
#
# Note (Phase 8, Task 6): `ingestion` now has a Dockerfile and `pipeline-worker`
# is now a docker-compose service too (see docker-compose.yml) — the exact
# same upload -> diff -> confirm -> re-run -> 100%-reuse assertions have been
# verified to hold when the stack is driven entirely through
# `docker compose up -d --build` instead of local processes. This script is
# intentionally left targeting local processes: it's faster for local dev
# iteration (no image rebuilds) and doesn't need Docker running at all; use
# `docker compose up -d --build` directly for full-stack/production parity
# checks. Both paths are proven-equivalent — pick whichever fits the task.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT_DIR/docs/golden-e2e-fixture.txt"

PG_CONTAINER="req2ado-temp-pg-5432"
REDIS_CONTAINER="req2ado-temp-redis-6379"
PG_PORT=5432
REDIS_PORT=6379
STARTED_PG=0
STARTED_REDIS=0

# 8000 is intentionally avoided: on this dev machine it's already bound by
# an unrelated project's Docker container (elisradevops-python-download-service),
# which answers with its own 404 and silently masks a real ingestion-boot
# failure as a false "healthy" if reused.
INGESTION_PORT=8010
MCP_PORT=4100
ORCH_PORT=3001

MOCK_DB_DIR="$(mktemp -d /tmp/req2ado-mock-ado.XXXXXX)"
LOG_DIR="$(mktemp -d /tmp/req2ado-e2e-logs.XXXXXX)"

PIDS=()

log() { printf '\n[golden-e2e] %s\n' "$1"; }

cleanup() {
  local exit_code=$?
  log "Cleaning up (exit code $exit_code)..."

  for pid in "${PIDS[@]:-}"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  if [ "$STARTED_PG" -eq 1 ]; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$STARTED_REDIS" -eq 1 ]; then
    docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  fi

  rm -rf "$MOCK_DB_DIR"

  if [ "$exit_code" -ne 0 ]; then
    log "FAILED. Logs preserved at: $LOG_DIR"
  else
    rm -rf "$LOG_DIR"
  fi

  exit "$exit_code"
}
trap cleanup EXIT

wait_for_http() {
  local url="$1"
  local name="$2"
  local tries=60
  for ((i = 0; i < tries; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "$name is up ($url)"
      return 0
    fi
    sleep 1
  done
  log "TIMED OUT waiting for $name ($url)"
  return 1
}

# ---------------------------------------------------------------------------
# 1. Postgres + Redis
# ---------------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  log "Reusing existing postgres container: $PG_CONTAINER"
else
  log "Starting fresh postgres container on port $PG_PORT"
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=req2ado -e POSTGRES_PASSWORD=req2ado -e POSTGRES_DB=req2ado \
    -p "$PG_PORT:5432" postgres:16-alpine >/dev/null
  STARTED_PG=1
fi

if docker ps --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
  log "Reusing existing redis container: $REDIS_CONTAINER"
else
  log "Starting fresh redis container on port $REDIS_PORT"
  docker run -d --name "$REDIS_CONTAINER" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
  STARTED_REDIS=1
fi

log "Waiting for postgres to accept connections..."
for ((i = 0; i < 30; i++)); do
  if docker exec "$PG_CONTAINER" pg_isready -U req2ado >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export DATABASE_URL="postgresql://req2ado:req2ado@localhost:${PG_PORT}/req2ado"
export REDIS_URL="redis://localhost:${REDIS_PORT}"

# ---------------------------------------------------------------------------
# 2. Orchestrator: build, migrate, seed
# ---------------------------------------------------------------------------
log "Building orchestrator (prisma generate + nest build)..."
(cd "$ROOT_DIR/orchestrator" && npx prisma generate >"$LOG_DIR/prisma-generate.log" 2>&1)
(cd "$ROOT_DIR/orchestrator" && npx prisma migrate deploy >"$LOG_DIR/prisma-migrate.log" 2>&1)
(cd "$ROOT_DIR/orchestrator" && npx nest build >"$LOG_DIR/nest-build.log" 2>&1)

log "Seeding placeholder user row (JobsController hardcodes userId: 'placeholder-user-id')..."
docker exec "$PG_CONTAINER" psql -U req2ado -d req2ado -c \
  "INSERT INTO \"User\" (id, email) VALUES ('placeholder-user-id', 'golden-e2e@example.com') ON CONFLICT (id) DO NOTHING;" \
  >"$LOG_DIR/seed-user.log" 2>&1

# ---------------------------------------------------------------------------
# 3. Ingestion service (Python/FastAPI)
# ---------------------------------------------------------------------------
log "Starting ingestion service on :$INGESTION_PORT"
(
  cd "$ROOT_DIR/ingestion"
  # ORCHESTRATOR_URL/LLM_PROXY_BEARER: SURVEY mode (job #3, added for the
  # SURVEY golden scenario) calls back into the orchestrator's /llm/chat
  # proxy — LLM_PROXY_BEARER here must match the value the orchestrator
  # process below checks incoming requests against.
  export ORCHESTRATOR_URL="http://localhost:${ORCH_PORT}"
  export LLM_PROXY_BEARER=dev-only-llm-proxy-bearer
  # CHROMA_PERSIST_PATH: isolate this run's vector store under LOG_DIR (which
  # the EXIT trap removes) rather than ingestion's default ./.req2ado/vectors
  # — otherwise job #1's items persist across script runs and can produce
  # spurious dedup_skip matches on what should be a clean-state job #1.
  export CHROMA_PERSIST_PATH="$LOG_DIR/vectors"
  # shellcheck disable=SC1091
  source .venv/bin/activate
  exec uvicorn app.main:app --port "$INGESTION_PORT" --host 127.0.0.1
) >"$LOG_DIR/ingestion.log" 2>&1 &
PIDS+=($!)

# ---------------------------------------------------------------------------
# 4. mcp-ado-server (mock ADO backend)
# ---------------------------------------------------------------------------
log "Starting mcp-ado-server on :$MCP_PORT (ADO_BACKEND=mock)"
(
  cd "$ROOT_DIR/mcp-ado-server"
  export PORT="$MCP_PORT"
  export ADO_BACKEND=mock
  export MCP_BEARER=dev-local-only
  export MOCK_DB_PATH="$MOCK_DB_DIR/mock_ado.sqlite"
  exec npx tsx src/index.ts
) >"$LOG_DIR/mcp-ado-server.log" 2>&1 &
PIDS+=($!)

# ---------------------------------------------------------------------------
# 5. Orchestrator main HTTP app
# ---------------------------------------------------------------------------
log "Starting orchestrator HTTP app on :$ORCH_PORT"
(
  cd "$ROOT_DIR/orchestrator"
  export PORT="$ORCH_PORT"
  export DATABASE_URL
  export REDIS_URL
  export MCP_URL="http://localhost:${MCP_PORT}"
  export MCP_BEARER=dev-local-only
  export AUTH_PROVIDER=ado_pat
  export AUTH_JWT_SECRET=dev-only-jwt-secret
  # LLM_BASE_URL/LLM_CHAT_MODEL: point at a real local Ollama so the SURVEY
  # scenario (job #3) below can genuinely generate hierarchy + requirement
  # text, not a fake/unreachable placeholder. BASELINE jobs #1/#2 never call
  # the LLM proxy, so this has no effect on them.
  export LLM_BASE_URL="http://localhost:11434/v1"
  export LLM_CHAT_MODEL=llama3.2:1b
  export LLM_PROXY_BEARER=dev-only-llm-proxy-bearer
  # EMBED_MODEL: real, locally-pulled Ollama embedding model — the dedup
  # scenario (job #4, Task 9) calls this via the /llm/embed proxy. A
  # placeholder name here 404s against a real Ollama instance.
  export EMBED_MODEL=all-minilm
  export EMBED_TRANSPORT=ollama
  export EMBED_PATH=/api/embed
  export INGESTION_BASE_URL="http://localhost:${INGESTION_PORT}"
  exec node dist/main.js
) >"$LOG_DIR/orchestrator.log" 2>&1 &
PIDS+=($!)

# ---------------------------------------------------------------------------
# 6. Orchestrator pipeline worker (separate BullMQ worker process)
# ---------------------------------------------------------------------------
log "Starting orchestrator pipeline worker (separate process)"
(
  cd "$ROOT_DIR/orchestrator"
  export DATABASE_URL
  export REDIS_URL
  export MCP_URL="http://localhost:${MCP_PORT}"
  export MCP_BEARER=dev-local-only
  export AUTH_PROVIDER=ado_pat
  export AUTH_JWT_SECRET=dev-only-jwt-secret
  export LLM_BASE_URL="http://localhost:9999"
  export LLM_CHAT_MODEL=dev-unused-chat-model
  export LLM_PROXY_BEARER=dev-only-llm-proxy-bearer
  export EMBED_MODEL=all-minilm
  export EMBED_TRANSPORT=ollama
  export EMBED_PATH=/api/embed
  export INGESTION_BASE_URL="http://localhost:${INGESTION_PORT}"
  exec node dist/modules/pipeline/pipeline-worker.main.js
) >"$LOG_DIR/pipeline-worker.log" 2>&1 &
PIDS+=($!)

# ---------------------------------------------------------------------------
# 7. Wait for readiness
# ---------------------------------------------------------------------------
wait_for_http "http://localhost:${INGESTION_PORT}/health" "ingestion"
wait_for_http "http://localhost:${MCP_PORT}/health" "mcp-ado-server"
wait_for_http "http://localhost:${ORCH_PORT}/health" "orchestrator"

# The pipeline worker has no HTTP health endpoint (it's a BullMQ consumer,
# not a server) — give it a moment to connect to Redis and log its startup
# banner before we enqueue anything.
sleep 2
if ! grep -q "listening for jobs" "$LOG_DIR/pipeline-worker.log" 2>/dev/null; then
  log "Pipeline worker did not print its startup banner yet — log so far:"
  cat "$LOG_DIR/pipeline-worker.log" || true
fi

AREA_PATH="Project\\GoldenE2E"

# ---------------------------------------------------------------------------
# 8. First job: submit -> poll diff_ready -> confirm -> assert createdCount
# ---------------------------------------------------------------------------
poll_job_status() {
  local job_id="$1"
  local tries=60
  for ((i = 0; i < tries; i++)); do
    local body
    body="$(curl -sf "http://localhost:${ORCH_PORT}/jobs/${job_id}")"
    local status
    status="$(echo "$body" | jq -r '.status')"
    if [ "$status" = "diff_ready" ] || [ "$status" = "failed" ]; then
      echo "$body"
      return 0
    fi
    sleep 1
  done
  log "TIMED OUT waiting for job $job_id to reach diff_ready"
  return 1
}

log "Submitting job #1 (baseline fixture)"
JOB1_RESPONSE="$(curl -sf -X POST "http://localhost:${ORCH_PORT}/jobs" \
  -F "file=@${FIXTURE}" \
  -F "areaPath=${AREA_PATH}")"
JOB1_ID="$(echo "$JOB1_RESPONSE" | jq -r '.jobId')"
log "Job #1 id: $JOB1_ID"

JOB1_BODY="$(poll_job_status "$JOB1_ID")"
JOB1_STATUS="$(echo "$JOB1_BODY" | jq -r '.status')"
log "Job #1 status: $JOB1_STATUS"
if [ "$JOB1_STATUS" != "diff_ready" ]; then
  log "Job #1 did not reach diff_ready. Body: $JOB1_BODY"
  log "--- orchestrator.log ---"; tail -n 80 "$LOG_DIR/orchestrator.log" || true
  log "--- pipeline-worker.log ---"; tail -n 80 "$LOG_DIR/pipeline-worker.log" || true
  log "--- ingestion.log ---"; tail -n 80 "$LOG_DIR/ingestion.log" || true
  exit 1
fi

JOB1_DIFF_ACTIONS="$(echo "$JOB1_BODY" | jq -r '.dryRunDiff[].action')"
log "Job #1 dry-run diff actions: $(echo "$JOB1_DIFF_ACTIONS" | tr '\n' ' ')"
if ! echo "$JOB1_DIFF_ACTIONS" | grep -q "create"; then
  log "ASSERTION FAILED: expected job #1's dry-run diff to contain at least one 'create' action"
  exit 1
fi

log "Confirming job #1"
CONFIRM1_RESPONSE="$(curl -sf -X POST "http://localhost:${ORCH_PORT}/jobs/${JOB1_ID}/confirm")"
CONFIRM1_CREATED_COUNT="$(echo "$CONFIRM1_RESPONSE" | jq -r '.createdCount')"
log "Job #1 confirm response: $CONFIRM1_RESPONSE"
if [ "$CONFIRM1_CREATED_COUNT" -lt 1 ]; then
  log "ASSERTION FAILED: expected createdCount >= 1, got $CONFIRM1_CREATED_COUNT"
  exit 1
fi

# ---------------------------------------------------------------------------
# 9. Second job: identical fixture -> expect ALL entries to be 'reuse'
# ---------------------------------------------------------------------------
log "Submitting job #2 (identical fixture, same areaPath, no customerId — idempotency re-run check)"
JOB2_RESPONSE="$(curl -sf -X POST "http://localhost:${ORCH_PORT}/jobs" \
  -F "file=@${FIXTURE}" \
  -F "areaPath=${AREA_PATH}")"
JOB2_ID="$(echo "$JOB2_RESPONSE" | jq -r '.jobId')"
log "Job #2 id: $JOB2_ID"

JOB2_BODY="$(poll_job_status "$JOB2_ID")"
JOB2_STATUS="$(echo "$JOB2_BODY" | jq -r '.status')"
log "Job #2 status: $JOB2_STATUS"
if [ "$JOB2_STATUS" != "diff_ready" ]; then
  log "Job #2 did not reach diff_ready. Body: $JOB2_BODY"
  exit 1
fi

JOB2_DIFF="$(echo "$JOB2_BODY" | jq -c '.dryRunDiff')"
JOB2_NON_REUSE_COUNT="$(echo "$JOB2_BODY" | jq '[.dryRunDiff[] | select(.action != "reuse")] | length')"
JOB2_ENTRY_COUNT="$(echo "$JOB2_BODY" | jq '.dryRunDiff | length')"
log "Job #2 dry-run diff: $JOB2_DIFF"

if [ "$JOB2_ENTRY_COUNT" -lt 1 ]; then
  log "ASSERTION FAILED: expected job #2's dry-run diff to have at least one entry"
  exit 1
fi
if [ "$JOB2_NON_REUSE_COUNT" -ne 0 ]; then
  log "ASSERTION FAILED: expected ALL of job #2's diff entries to be 'reuse' (idempotent re-run), found $JOB2_NON_REUSE_COUNT non-reuse entr(y/ies)"
  exit 1
fi

log "GOLDEN E2E PASSED: job #1 created $CONFIRM1_CREATED_COUNT work item(s); job #2's re-run diff was 100% reuse ($JOB2_ENTRY_COUNT/$JOB2_ENTRY_COUNT entries)."

# ---------------------------------------------------------------------------
# 10. Third job: SURVEY mode against an informal, unstructured fixture —
#     proves Tasks 1-4 (LLM hierarchy inference + batched requirement
#     formalization + mode threading) compose end-to-end against the real
#     mock ADO backend and a real local LLM.
# ---------------------------------------------------------------------------
log "Submitting job #3 (SURVEY mode, informal fixture)"
JOB3_RESPONSE=$(curl -sf -X POST "http://localhost:${ORCH_PORT}/jobs" \
  -F "file=@${ROOT_DIR}/docs/golden-e2e-survey-fixture.txt" \
  -F "areaPath=${AREA_PATH}" \
  -F "mode=survey")
JOB3_ID="$(echo "$JOB3_RESPONSE" | jq -r '.jobId')"
log "Job #3 id: $JOB3_ID"

JOB3_BODY="$(poll_job_status "$JOB3_ID")"
JOB3_STATUS="$(echo "$JOB3_BODY" | jq -r '.status')"
if [ "$JOB3_STATUS" != "diff_ready" ]; then
  log "Job #3 (SURVEY) did not reach diff_ready. Body: $JOB3_BODY"
  exit 1
fi

JOB3_TITLES="$(echo "$JOB3_BODY" | jq -r '.dryRunDiff[].title')"
log "Job #3 (SURVEY) generated titles: $JOB3_TITLES"
if [ -z "$JOB3_TITLES" ]; then
  log "ASSERTION FAILED: SURVEY job produced no titled nodes at all"
  exit 1
fi

# ---------------------------------------------------------------------------
# 11. Fourth job: BASELINE mode, a NEAR-duplicate (not identical) of job #1's
#     fixture against the same areaPath — proves Tasks 6-8 (embedding dedup
#     check wired into the dry-run diff, real vector-store upsert on confirm)
#     compose end-to-end. A near-duplicate misses the exact-hash idempotency
#     lookup (different bytes, different sourceHash) but should still match
#     job #1's already-upserted embedding above the 0.90 similarity threshold.
# ---------------------------------------------------------------------------
log "Submitting job #4 (BASELINE mode, near-duplicate of job #1's fixture — dedup check)"
JOB4_RESPONSE="$(curl -sf -X POST "http://localhost:${ORCH_PORT}/jobs" \
  -F "file=@${ROOT_DIR}/docs/golden-e2e-near-duplicate-fixture.txt" \
  -F "areaPath=${AREA_PATH}")"
JOB4_ID="$(echo "$JOB4_RESPONSE" | jq -r '.jobId')"
log "Job #4 id: $JOB4_ID"

JOB4_BODY="$(poll_job_status "$JOB4_ID")"
JOB4_STATUS="$(echo "$JOB4_BODY" | jq -r '.status')"
if [ "$JOB4_STATUS" != "diff_ready" ]; then
  log "Job #4 (dedup) did not reach diff_ready. Body: $JOB4_BODY"
  exit 1
fi

JOB4_DIFF="$(echo "$JOB4_BODY" | jq -c '.dryRunDiff')"
JOB4_DEDUP_SKIP_COUNT="$(echo "$JOB4_BODY" | jq '[.dryRunDiff[] | select(.action == "dedup_skip")] | length')"
log "Job #4 dry-run diff: $JOB4_DIFF"
if [ "$JOB4_DEDUP_SKIP_COUNT" -lt 1 ]; then
  log "ASSERTION FAILED: expected job #4's near-duplicate diff to contain at least one 'dedup_skip' action"
  exit 1
fi

log "GOLDEN E2E PASSED (dedup): job #4's near-duplicate diff flagged $JOB4_DEDUP_SKIP_COUNT node(s) as dedup_skip."

log "GOLDEN E2E (SURVEY) PASSED: job #3 produced $(echo "$JOB3_BODY" | jq '.dryRunDiff | length') node(s) from an informal fixture."
