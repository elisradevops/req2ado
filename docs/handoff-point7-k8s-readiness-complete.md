# Handoff — Point 7: Kubernetes deployment readiness (complete, 7/7)

Follows `docs/handoff-point7-k8s-readiness-partial.md` (5/7 tasks). This
closes the remaining two: Chroma horizontal-scaling externalization, and
the k8s manifests themselves.

## What changed since the partial handoff

**6. Chroma horizontal-scaling externalization** —
`ChromaVectorStore` previously only supported a local
`chromadb.PersistentClient`, meaning ingestion could never safely run more
than one replica (each would hold an independent, incomplete dedup
corpus) — directly contradicting `docs/architecture.md`'s "stateless,
scaled ×N" claim for ingestion. Added a second mode:
- New `Settings.chroma_mode` (`"embedded"` default = unchanged
  `PersistentClient` behavior, `"http"` = `chromadb.HttpClient` against a
  real shared server) + `chroma_host`/`chroma_port`.
- `ChromaVectorStore.__init__` gained optional `mode`/`host`/`port`
  params; every existing "embedded"-mode call site (all of them, before
  this round) needed zero changes.
- `docker-compose.yml`'s previously-commented-out `chroma` service is now
  live (real `chromadb/chroma:latest` image, persistent volume), and
  `ingestion`'s environment sets `CHROMA_MODE=http` pointing at it.
- `docs/architecture.md`'s stale "stateless, scaled ×N" line corrected to
  state the real condition (only true when `CHROMA_MODE=http`).
- **Live-verified**: rebuilt ingestion against the real `chroma` container,
  confirmed `/ready` reports real Chroma reachability over HTTP (not the
  local client), and ran a real `/dedup/check` call that round-tripped
  through the actual HTTP-mode Chroma server successfully.

**7. Kubernetes manifests** — none existed in this worktree before. Added
`k8s/` with 11 files (17 objects total): `Namespace`, `ConfigMap` (all
non-secret config), a `Secret` template (`.example`, never the real file),
`StatefulSet`+`Service` for Postgres and Chroma, `Deployment`+`Service` for
Redis, a one-shot `Job` for `prisma migrate deploy` (maps onto the
docker-compose `migrate` service and Dockerfile's own `builder`-stage
comment), and `Deployment`+`Service` for orchestrator/mcp-ado-server/
ingestion (liveness=`/health`, readiness=`/ready` on all three) plus a
`Service`-less `Deployment` for pipeline-worker. `k8s/README.md` documents
apply order and every deliberately-out-of-scope gap (no Ingress/frontend
deployment yet, no tuned resource limits, no NetworkPolicy/RBAC, no
`storageClassName` pinned to a specific cluster). Verified: every manifest
parses as valid YAML and passes a structural sanity check (apiVersion/
kind/metadata.name present, every container has an image) — no live
cluster was reachable this round to run a real `kubectl apply --dry-run`
schema validation, noted honestly rather than claimed as done.

## Verification (full point-7 status)

- `ingestion`: `.venv/bin/python -m pytest` — 219/226 passing (7
  pre-existing unrelated poppler failures, unchanged count). New this
  round: 2 `ChromaVectorStore` mode-construction tests (mocked
  `PersistentClient`/`HttpClient`, no real server needed for the unit
  tests).
- **Live docker-compose verification**: `chroma` service brought up for
  the first time in this worktree, ingestion rebuilt and reconnected to it
  over HTTP, `/ready` confirmed real reachability, one real dedup check
  round-tripped successfully.
- k8s manifests: YAML-parse + structural validation only (no cluster
  available this round for `kubectl apply --dry-run=server` or a real
  `kind`/`minikube` smoke test) — flagged as the honest verification
  boundary, not silently passed over.

All 7 findings from the original code review's §7 are now addressed.
