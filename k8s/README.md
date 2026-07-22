# req2ado — Kubernetes manifests

Closes `docs/handoff.md`'s code-review §7 finding: this worktree had no k8s
manifests at all. These map the `docker-compose.yml` topology onto k8s
primitives — they're a starting point for a real deployment, not a
production-hardened, fully-optioned Helm chart.

## Layout

| File | What |
|---|---|
| `00-namespace.yaml` | `req2ado` namespace |
| `01-configmap.yaml` | Non-secret config (mirrors `.env.template`'s non-credential fields) |
| `02-secret.yaml.example` | **Template only** — copy to `02-secret.yaml`, fill in real values, never commit it |
| `10-postgres.yaml` | Postgres `StatefulSet` + PVC + headless `Service` |
| `11-redis.yaml` | Redis `Deployment` (no PVC — queue/pub-sub state is transient, matches docker-compose) + `Service` |
| `12-chroma.yaml` | Chroma `StatefulSet` + PVC + `Service` — the one stateful thing ingestion depends on now that it's externalized (see `docs/handoff-point7-*.md`) |
| `20-migrate-job.yaml` | One-shot `Job` running `prisma migrate deploy` — maps onto docker-compose's `migrate` service / the pattern the orchestrator Dockerfile's comment describes |
| `21-orchestrator.yaml` | Orchestrator API `Deployment` + `Service`, liveness=`/health`, readiness=`/ready` |
| `22-pipeline-worker.yaml` | BullMQ pipeline-worker `Deployment` — no `Service` (nothing calls it directly) |
| `23-mcp-ado-server.yaml` | mcp-ado-server `Deployment` + `Service`, liveness=`/health`, readiness=`/ready` |
| `24-ingestion.yaml` | Ingestion `Deployment` + `Service`, liveness=`/health`, readiness=`/ready`. **Safe to scale `replicas` beyond 1 only when `CHROMA_MODE=http`** (the default in `01-configmap.yaml` here) |

## Apply order

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-configmap.yaml
kubectl apply -f 02-secret.yaml   # after you've created it from the .example
kubectl apply -f 10-postgres.yaml -f 11-redis.yaml -f 12-chroma.yaml
kubectl wait --for=condition=ready pod -l app=postgres -n req2ado --timeout=120s
kubectl apply -f 20-migrate-job.yaml
kubectl wait --for=condition=complete job/req2ado-migrate -n req2ado --timeout=120s
kubectl apply -f 21-orchestrator.yaml -f 22-pipeline-worker.yaml -f 23-mcp-ado-server.yaml -f 24-ingestion.yaml
```

## Known gaps, deliberately not solved here

- **No Ingress / frontend Deployment** — the frontend package itself is
  still commented out of `docker-compose.yml` (never built in this
  worktree either); nothing to deploy yet.
- **No resource requests/limits tuned for a real cluster** — placeholder
  values only, size them against real node capacity before using this
  anywhere but a dev/staging cluster.
- **No NetworkPolicy / PodSecurityStandard / RBAC ServiceAccount scoping**
  — out of scope for "does a k8s manifest exist at all."
- **Postgres/Chroma StatefulSets use a generic `PersistentVolumeClaim`
  with no explicit `storageClassName`** — set one matching your cluster
  (the other `req2ado` repo's own k8s work, per its handoff doc, uses
  `nfs-client`; not assumed here since this worktree has no evidence of
  which cluster it targets).
- **PAT/PAT-adjacent secrets**: per `docs/architecture.md`, the ADO PAT is
  never a server-side credential at all (entered per-request at the login
  screen) — `02-secret.yaml.example` only holds the values that
  legitimately are static secrets (LLM proxy bearer, MCP bearer, DB
  password, on-prem CA cert content if self-signed).
