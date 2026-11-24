# Runbook: probing a req2ado release in production

For whoever prepares a production probe: a prompt for the production-side agent, or steps for the operator. It collects what the
PR #53 probe (2026-11-24) learned. Production is read-only for the probe: the operator runs every `kubectl` and `helm` command.

## Production is not named like the chart

| What | Repo chart (`deploy/helm/req2ado`) | Production |
|---|---|---|
| Orchestrator, worker, ADO server | deployment `<release>-app` (containers `web`, `orchestrator`, `pipeline-worker`, `mcp-ado-server`) | deployment `req2ado-api` (containers `orchestrator`, `pipeline-worker`, `mcp-ado-server`) |
| Ingestion | deployment `<release>-ingestion`, container `ingestion` | deployment `req2ado-ingestion`, container `req2ado-ingestion` |
| Frontend | container `web` in `<release>-app` | deployment `req2ado-frontend` |
| Environment | config map `req2ado-config` (from `values.yaml` → `config:`) | the same config map, from production's own values |

Write probe text with the production names, or ask the agent to discover them. Never hard-code a namespace, a host or a registry in a
probe text: they are not to appear in any report.

## Before any eval: the new pods must be the only pods

An eval run while a deployment is being replaced can reach the old pod as it shuts down. The PR #53 probe's first attempt lost all 12
calls that way (HTTP 400s and connection resets, and nothing in the new pod's log). After every `helm upgrade` or restart:

```
kubectl -n <namespace> rollout status deploy/req2ado-api --timeout=10m
kubectl -n <namespace> rollout status deploy/req2ado-ingestion --timeout=10m
kubectl -n <namespace> rollout status deploy/req2ado-frontend --timeout=10m
kubectl -n <namespace> get pods      # no pod of an older ReplicaSet is still Running or Terminating
```

Then check the release: the running image tags are the ones under test, and a file the release added is present (for PR #53:
`/app/app/prompts/study_file_rules_document.v2.txt` in the ingestion container). An upgrade that ran before its values file was saved has
deployed old tags before; this check catches it.

If an eval call is refused, the orchestrator now logs one warning line per refused `/llm/chat`, `/llm/embed` or `/llm/vision` request. Each
line gives the route, the status, the reason, the invalid field paths, the job and the stage, but never the user, the body or upstream text.

## When an upgrade fails

- **The release is stuck in `pending-upgrade`** (a later `helm upgrade` refuses to run): production's chart ships
  `scripts/repair-pending-upgrade.sh`. It marks the stuck revision failed and changes no application resource or data. Run it, then
  upgrade again.
- **A new image will not unpack on one node** (`failed to unmount …/containerd/tmpmounts/…: device or resource busy`, while other images
  pull fine): this is the node, not the release. Roll back, redeploy, and send the node's administrators the note in
  [Image layer cannot be unpacked](#image-layer-cannot-be-unpacked-for-the-node-administrators) below.
- Prefer applying a single configuration value by patching the config map and restarting the two deployments over a `helm upgrade`:
  production Helm upgrades have been unstable (the migration job), and a chart version bump restarts the stateful pods.

## What can run inside the ingestion container

Both ship in the image. Nothing has to be downloaded, which matters because the operator's downloads from the repository are blocked.

- **Prompt evals** (synthetic fixtures only). The container's own route and bearer are used, so no token is handled:
  `python -m tests.prompt_evals.run --user-id <user> --model <model> --family <family> --repeat 3 --out /tmp/report.json`
  - The report's `cases` is keyed by case. Each case has `passed`, `passed_runs`, `outcome` (`blocked` means the provider's content
    filter refused the call) and `checks` (`[ok, reason]`).
  - Time the run from outside to get seconds per call.
- **Structure counts of a real document** (numbers only, never its text, no model call):
  `cd /app && python scripts/pdf_structure_counts.py --json --no-name /tmp/<neutral-name>.pdf`
  Copy the document in under a neutral name, and delete it from `/tmp` right after.

## What a report may contain

- Numbers, pass/fail, statuses, version tags, and the value of the one configuration key under test.
- Never: secrets, user ids, hostnames, node names, IPs, registry hosts, organization namespaces, document file names or document text.
- No connection tests or HTTP requests to internal hosts on TCP 80/443, and none scripted for the operator.

## Image layer cannot be unpacked (for the node administrators)

On one node, pulls of a new image fail every time while extracting one layer, with
`failed to unmount <containerd root>/tmpmounts/containerd-mount…: device or resource busy`. Other images pull fine on the same node.
Something holds containerd's temporary mounts open. Please check:

1. What holds the mounts: `lsof +D <containerd root>/tmpmounts` and `fuser -vm <containerd root>/tmpmounts/*` (as root). Also check for a
   leaked mount: `findmnt | grep tmpmounts`.
2. Whether an on-access security agent (antivirus or EDR) scans containerd's data directory. If so, exclude `<containerd root>`
   (usually `/var/lib/containerd`) from on-access scanning.
3. After freeing the mounts, or after a containerd restart in a maintenance window (the database also runs on that node), retry the pull.
