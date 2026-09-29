# req2ado — Helm chart

Consolidates the previous 13-pod / 7-service topology (5 HPAs pinning every
app Deployment at `minReplicas: 2`, none of them functional — see below)
into one app pod (nginx + orchestrator + pipeline-worker + mcp-ado-server)
plus ingestion, chroma, postgres, and valkey. 13 pods → 5, 7 services → 5,
2 NodePorts → 0.

Production previously ran Helm release `req2ado`, chart `req2ado-0.1.0`
(revision 7) — **that chart was never in git**. This chart replaces it as
the source of truth, targeting the same release name (`req2ado`) and the
same resource names, so `helm upgrade` adopts the live release rather than
creating a parallel one.

## Before the first upgrade against production — protect the secrets

`req2ado-secrets` holds `CREDENTIAL_ENC_KEY` (every vaulted ADO PAT is
encrypted with it — losing the key makes them permanently undecryptable).
No template in this chart manages `req2ado-secrets` or `req2ado-ado-ca`;
without the annotation below, Helm prunes both on the first apply because
they aren't declared anywhere in the new release.

```sh
kubectl get secret req2ado-secrets req2ado-ado-ca -n req2ado -o yaml > secrets-backup.yaml   # store securely, never commit
kubectl annotate secret req2ado-secrets req2ado-ado-ca -n req2ado helm.sh/resource-policy=keep
```

Also back up the database: `pg_dump` (or your existing snapshot mechanism)
before the first upgrade.

## Why 5 HPAs are simply deleted, not reconfigured

`kubectl top pods -n req2ado` returns `ServiceUnavailable`even though the
`v1beta1.metrics.k8s.io` APIService reports itself `Available` — real
cluster-wide metrics-server breakage, not a namespace-local issue. Every
`req2ado-*` HPA's own status confirms it: `failed to get cpu utilization:
no metrics returned from resource metrics API`. None of the five have ever
scaled anything; `minReplicas: 2` is the entire effect they've had,
permanently doubling every app pod. Pipeline throughput does not depend on
replica count — `PIPELINE_WORKER_CONCURRENCY=4` (`req2ado-config`) sets
concurrency *inside* the single worker process.

## Install / upgrade

```sh
helm upgrade req2ado ./deploy/helm/req2ado -n req2ado \
  --set image.registry=<your-registry>/docker
```

`image.registry` has no default on purpose — an unset value would silently
pull unqualified images from Docker Hub instead of your internal mirror.

Verify:

```sh
kubectl get pods,svc,hpa -n req2ado
# expect: 5 pods, 5 services, 0 HPAs, 0 NodePorts (once ingress.enabled and
# service.type: ClusterIP -- see "Exposure" below for the transitional
# default)

kubectl exec -n req2ado deploy/req2ado-app -c web -- cat /usr/share/nginx/html/config.json
# expect: {"apiBaseUrl": "/api"}  -- confirms the frontend config-injection
# fix (frontend/docker-entrypoint.d/40-req2ado-config.sh) actually ran
```

## Exposure — NodePort now, Ingress once DNS/cert exist

`values.yaml` defaults to `service.type: NodePort` (`nodePort: 30100`) so
the chart installs with nothing blocked on DNS or certificate issuance.
`ingress.enabled` defaults to `false`.

To cut over to the Ingress, mirroring `docgen-ingress` (already running
against this cluster's Traefik for 196+ days, no `ingressClassName`, no
annotations):

1. Request from IT/Cyber, matching DocGen's own pattern exactly:
   - DNS records for **both** `req2ado` and `req2ado.<domain>.co.il`
     (DocGen resolves both a short name and an FQDN to the same node IPs —
     `docgen-tls`'s SAN list is `DNS:docgen, DNS:docgen.<domain>.co.il`).
   - An internal-CA certificate with the same two names as SANs, issued
     the same way as `docgen-tls`. Load it as a `kubernetes.io/tls` Secret
     named to match `.Values.ingress.tls.secretName` (default
     `req2ado-tls`).
2. `helm upgrade req2ado ./deploy/helm/req2ado -n req2ado --set ingress.enabled=true --set ingress.host=req2ado.<domain>.co.il`
3. Confirm `https://req2ado.<domain>.co.il` serves the app correctly —
   including a full job run through to ADO write-back, to prove SSE job
   progress survives Traefik + nginx's proxy (`proxy_buffering off` in
   `frontend/nginx.conf.template` is the load-bearing setting there).
4. Only once satisfied, flip `service.type` to `ClusterIP` and re-run
   `helm upgrade` — this removes NodePort `30100`, and IT/Cyber can then
   close both `30100` and the retired `30101`.

No new firewall port is ever opened at any step — Traefik's 80/443 predate
this change, and DocGen has used them for years.

## What deliberately stays out of this chart

- **mcp-ado-server has no Service.** It has exactly one consumer
  (orchestrator/pipeline-worker, both now sibling containers in the same
  pod) — nothing in `frontend/src` or `ingestion/app` calls it. It's a
  `localhost:4100` call now, not a cluster DNS name.
- **ingestion stays a separate Deployment.** ~1GB Python image
  (tesseract/poppler/LibreOffice) with its own lifecycle, and
  bidirectionally coupled to the orchestrator (`orchestrator → /level,
  /ingest,/dedup,/kb`; `ingestion → ORCHESTRATOR_URL`'s `/llm/*` proxy).
  Folding it into the app pod would couple that image to every
  orchestrator deploy for no operational gain.
- **chroma stays a separate StatefulSet.** Already `replicas: 1` and
  ClusterIP-internal — it isn't part of the duplication problem. Folding
  it into ingestion as an embedded store (`CHROMA_MODE=embedded`) would
  require migrating the live 20Gi PVC between Chroma versions; not worth
  the risk for zero pod-count benefit.

## Names and fields that must never change

Every template's `req2ado.fullname` helper resolves to `.Release.Name`
(expected: `req2ado`), which is why every resource name below matches
production exactly:

| Resource | Why it's frozen |
|---|---|
| StatefulSet/Service `req2ado-postgres` | PVC `data-req2ado-postgres-0` is bound by name |
| StatefulSet/Service `req2ado-chroma` | PVC `data-req2ado-chroma-0` |
| `spec.selector`, `volumeClaimTemplates` on both StatefulSets | **immutable** on `apps/v1` StatefulSet — any edit fails `helm upgrade` outright |
| `storageClassName: nfs-client`, storage size `20Gi` on both | part of the immutable claim template |
| Secret names `req2ado-secrets`, `req2ado-ado-ca` | referenced, never templated — see the resource-policy note above |

## Deprecated: `req2ado/k8s/`

The old `k8s/` directory (plain manifests, no Helm) is deleted as part of
this consolidation — it described two conflicting generations of the
deployment, neither matching what was actually running (wrong Service
name `redis` vs. the real `valkey`, no frontend manifest at all). This
chart is now the only description of the deployment that lives in git.
