# Handoff — Point 7: Kubernetes deployment readiness (partial: 5/7 tasks)

Source: `docs/handoff.md`'s code-review §7 ("Kubernetes deployment
readiness — not yet friendly"). 5 of 7 findings done and **live-verified
against a real docker-compose stack**, not just unit tests. Remaining:
k8s manifests themselves and Chroma horizontal-scaling externalization —
tracked separately, not done in this round (see "What's left").

## What changed

1. **Real `/health` (liveness) + `/ready` (readiness) split, all 3 services**
   — every service previously had one endpoint returning an unconditional
   `{ok: true}` with zero dependency checks.
   - **orchestrator**: `GET /health` stays a pure liveness check (no
     dependency touch, matches k8s semantics: a liveness failure restarts
     the pod, wrong response to "a dependency blipped"). New `GET /ready`
     does real Postgres (`$queryRaw SELECT 1`) + Redis (`ping()`) checks,
     503 if either fails. Found and fixed a real DI bug along the way:
     `import type` on `PrismaClient`/`Redis` erased the runtime class
     reference Nest's automatic constructor injection needs for a plain
     `@Controller()` — real imports fixed it (same bug class this codebase
     already documented for `IdempotencyService`, now also hit here).
   - **ingestion**: `GET /health` unchanged (liveness). New `GET /ready`
     checks real Chroma reachability via a new `ChromaVectorStore.ping()`
     (`heartbeat()`), 503 on failure.
   - **mcp-ado-server**: new `GET /ready`, mirroring `/health`'s existing
     mock-vs-real-backend split. For `backend=real`, honestly reports that
     ADO reachability can't be checked here (no server-level credential
     exists by design — only per-request headers) rather than faking a
     check.

2. **Graceful shutdown (SIGTERM/SIGINT), all 4 processes** — none had any
   signal handling before. `app.enableShutdownHooks()` for the orchestrator
   HTTP server; explicit `worker.close()` for the pipeline-worker BullMQ
   process; explicit `httpServer.close()` for mcp-ado-server; uvicorn's
   default SIGTERM handling for ingestion (Python) already worked once the
   Dockerfile's CMD was fixed to exec-form (see #3).
   - **Found and fixed a second real bug live**: `app.enableShutdownHooks()`
     alone did NOT make the orchestrator process actually exit — a raw,
     un-closed BullMQ `Queue` (in `JobsService`) and a raw ioredis client
     (in the new `HealthController`) each held an open socket that kept
     Node's event loop alive indefinitely. Added `OnModuleDestroy` hooks to
     both (`queue.close()` / `redis.disconnect()`), plus an `.unref()`'d
     10-second force-exit backstop in `main.ts` for any future un-wired
     handle. **Verified with a real `docker kill --signal=SIGTERM`
     against a running container** — before the fix, still `Status=running`
     10+ seconds later; after, `Status=exited ExitCode=0` within 3 seconds.
     All 4 services (orchestrator, pipeline-worker, mcp-ado-server,
     ingestion) verified the same way.

3. **DB migrations moved out of the app container's start command** —
   orchestrator's Dockerfile CMD was `sh -c "npx prisma migrate deploy &&
   node dist/main.js"`: shell-form (so `sh`, not `node`, was PID 1 — SIGTERM
   was never reliably forwarded, defeating #2 above even before it was
   fixed) and would race under multiple replicas. Split into a dedicated
   `migrate` docker-compose service (`command: ["npx", "prisma", "migrate",
   "deploy"]`, exits after running once) that `orchestrator`/
   `pipeline-worker` now `depends_on` with `condition:
   service_completed_successfully` — maps directly onto a k8s
   Job/initContainer pattern. **Verified live**: `migrate` container exits
   `0`, `orchestrator`/`pipeline-worker` only start after.

4. **Dockerfiles hardened — multi-stage builds, non-root user, all 3
   images**:
   - **orchestrator**: `builder` stage (full toolchain, `prisma generate`,
     `npm run build`) → `runtime` stage (prod-only deps via `npm ci
     --omit=dev`, copies `dist/`, the generated `.prisma/client`, and
     `prisma/`, runs as the alpine `node` user). The `migrate`
     docker-compose service now targets the `builder` stage specifically
     (the `prisma` CLI itself is a devDependency, stripped from `runtime`).
   - **mcp-ado-server**: same split; `better-sqlite3`'s native binary is
     `npm prune --omit=dev`'d in the *same* builder environment it was
     compiled in (rather than re-running `npm ci --omit=dev` toolchain-less
     in `runtime` and gambling on prebuild-install fetching a compatible
     musl binary) — safer, avoids introducing python3/make/g++ into the
     shipped image at all.
   - **Verified live**: rebuilt all three images, brought up the full
     stack, confirmed `docker exec ... whoami` → `node` for both hardened
     services, and ran a **real end-to-end pipeline job** (submit → ingest
     → level → dry-run diff, correctly `reuse`-matched a prior session's
     item) through the hardened containers to prove nothing broke
     functionally.

5. **Explicit BullMQ worker concurrency** — `new Worker(...)` previously
   set no `concurrency` option (BullMQ's implicit default: 1), a real
   horizontal-scaling throughput blocker independent of replica count. New
   `PIPELINE_WORKER_CONCURRENCY` config field (default 4), wired into the
   `Worker` constructor. Verified live: rebuilt, submitted a job, confirmed
   the pipeline still processes correctly under the new setting.

## What's left (not done this round — tracked as remaining tasks)

- **k8s manifests** (Deployments/Services/ConfigMaps/Secrets/resource
  requests-limits for all 5 app services + Postgres/Redis) — none exist in
  this worktree. Genuinely large, deliberately deferred to its own round.
- **Chroma horizontal-scaling externalization** — `ChromaVectorStore` still
  uses a local-disk `PersistentClient`; `docs/architecture.md`'s "stateless,
  scaled ×N" claim for ingestion still doesn't hold. Needs
  `chromadb.HttpClient` against a real shared Chroma deployment — separate,
  larger piece of work, not attempted here.

## Verification

- `orchestrator`: `npx jest --forceExit` — 144/144 passing (was 139). New:
  `test/health.controller.spec.ts` (5 tests, mocked Prisma/Redis — the e2e
  spec's DI wiring is proven by `test/health.e2e-spec.ts` booting the real
  `AppModule`), 2 `PIPELINE_WORKER_CONCURRENCY` config tests, 2 new
  `/ready` tests in `test/server.test.ts` equivalents. `npx jest
  test/pipeline.worker.spec.ts` etc. all still green.
- `mcp-ado-server`: `npx vitest run` — 70/70 passing (was 68). New: 2
  `/ready` tests.
- `ingestion`: `.venv/bin/python -m pytest` — 217/224 passing (7
  pre-existing unrelated poppler failures, same count as every prior point
  this session). New: 2 `/ready` tests, 2 `ChromaVectorStore.ping()` tests.
- **Live docker-compose verification** (this point's distinguishing work —
  every fix above was proven against real running containers, not just
  unit tests): rebuilt all 3 hardened images, confirmed non-root
  execution, confirmed `migrate` runs once and exits before app containers
  start, confirmed all `/health`+`/ready` endpoints on all 3 services,
  sent real `SIGTERM` to all 4 running containers and confirmed each
  exits cleanly within seconds (found and fixed 2 real bugs doing this:
  the DI `import type` issue and the un-closed-handle hang), and ran a
  real end-to-end pipeline job through the fully-hardened stack.
