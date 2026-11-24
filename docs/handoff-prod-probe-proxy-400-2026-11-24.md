# Production probe: what refuses the instant 400s (scoring eval, normal and paced)

## Goal

The 2026-11-24 scoring re-run failed no check. Every failed run was an HTTP 400 that the gateway answered in 33–45 ms (sometimes
0.4–2.5 s) with what our log called "no body", on both `claude-opus-5-5` and `OpenAI/gpt-5.4`.

From the Open WebUI v0.8.12 source: an error from the model provider is passed through with the provider's own body (LiteLLM:
`{"error": ...}`; Azure throttling is a 429, never a 400). Open WebUI's own refusals are `{"detail": "..."}`, which the OpenAI SDK
does not read, so they showed as "no body". On the chat route the only such 400 is its pre-flight model check (the model is missing
from its model registry, or the access check failed). This is inferred from source and not yet seen in production.

The release under test makes the reason visible and handles the refusal:

- orchestrator: the proxy's `detail` text now reaches the log (`message="400 <reason>"`); a proxy refusal is repeated once with the
  schema kept, then answered as **503 `LLM_PROXY_REJECTED: <reason>`** (no more "upstream rejected the response schema" for it);
- ingestion: a scoring vote lost to a transient error is repeated once; scores left on one vote get a `scoring_single_vote` warning;
- eval harness: a call the route failed is run once more; failing again it is outcome **`upstream_error`** with the orchestrator's
  text (not a failed case); `--pause-seconds N` waits N seconds between cases.

Run the scoring eval twice per model: normally (re-measure), then paced (a refusal that disappears when paced points to a rate
rule). Report results only. Fix nothing, tune nothing, deploy nothing.

## Hard rules

- **Read-only on production.** Change no deployment, Helm release, database row, setting, user or secret. Create no containers.
- **The release must already run** (step 1). If it does not, stop: report the running versions and do nothing else.
- **Never print, log or paste secrets or user ids:** bearers, API keys, cookies, connection strings, the eval user id. Redact them.
- **CUI:** no hostnames, IPs, registry hosts, organization namespaces, internal domains or personal names/emails in anything you
  hand back. Redact them from log lines.
- **No connection tests or HTTP requests** to TCP 80/443 on internal hosts, the LLM gateway included. Only the eval below calls it.
- **Cost:** only the scoring family, only the two models below, `--repeat 3`, two rounds per model. Synthetic fixtures only.
- **When anything fails:** record it verbatim (redacted) and go on.

## Inputs (ask the owner; do not guess)

- `EVAL_USER_ID`: the req2ado user id whose model connection is set in Settings (the one earlier probes used).

## Steps

1. Check the release is running:
   - orchestrator: `kubectl -n req2ado exec deploy/req2ado-api -c <orchestrator container> -- grep -c LLM_PROXY_REJECTED /app/dist/modules/llm/upstream-negotiation.js`
     (expect 1 or more);
   - ingestion: `kubectl -n req2ado exec deploy/req2ado-ingestion -- grep -c pause-seconds /app/tests/prompt_evals/run.py`
     (expect 1 or more).

   Record both image tags.
2. Round A, normal. In the production ingestion container, from `/app`. Note the UTC start and end time of each model's run:

   ```bash
   for M in claude-opus-5-5 OpenAI/gpt-5.4; do
     F=$(echo "$M" | tr '/:.' '___')
     date -u +%FT%TZ
     time python -m tests.prompt_evals.run --user-id "$EVAL_USER_ID" --model "$M" \
       --family score_requirements_for_document --repeat 3 --out "/tmp/score-$F-normal.json"
     date -u +%FT%TZ
   done
   ```

3. Wait 5 minutes. Round B, paced: the same loop with `--pause-seconds 20` and `--out "/tmp/score-$F-paced.json"`.
4. Orchestrator log for both rounds (same filter as round 2), from the first start time to the last end time:

   ```bash
   kubectl -n req2ado logs deploy/req2ado-api -c <orchestrator container> --since-time=<first start> \
     | grep -E "upstream call failed|upstream call gave up|proxy refused|refused twice|LLM_PROXY_REJECTED|rate limited"
   ```

   Redact hosts and ids. Keep every `message="..."` text verbatim: it is the reason this probe is for.
5. Per-run summary of every case that did not pass every run:

   ```bash
   for f in /tmp/score-*-normal.json /tmp/score-*-paced.json; do
     python - "$f" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print("==", sys.argv[1], r.get("model"))
for key, case in r["cases"].items():
    if case["passed"] and not any(run.get("upstream_failures") for run in case.get("repeats", [])):
        continue
    print(key, case.get("passed_runs"), case.get("outcome", ""), "failed_in_repeat:", case.get("failed_in_repeat"))
    for n, run in enumerate(case.get("repeats", []), start=1):
        print(f"  run {n}: passed={run['passed']} outcome={run.get('outcome', '')} error={run.get('error', '')[:200]}")
        for failure in run.get("upstream_failures", []):
            print(f"    route: {failure[:300]}")
        for check, detail in run.get("failed_checks", {}).items():
            print(f"    {check}: {detail}")
PY
   done
   ```

## What to hand back

1. The two image tags and `grep` counts from step 1.
2. Console output and wall time of every run (4 runs), with UTC start and end times, redacted.
3. The step 4 log lines, redacted, with a count per round and model of: proxy refusals (`status=400` with a `message` other
   than a provider error), 503 `LLM_PROXY_REJECTED` give-ups, 429s, content-filter blocks.
4. The full step 5 output, verbatim.
5. The four report files, user id redacted.
6. Anything you could not do, and why. A content-filter block on GPT for `kb_injection` is expected; report it, do not count it.

## Later (not part of this run)

Parts C and D of `docs/handoff-prod-probe-round-2026-11-24.md` once real jobs have run on this release, plus: the number of jobs
with a `scoring_single_vote` warning and its `detail.error` texts.

Do not judge the cause beyond what the log says. The owner decides.
