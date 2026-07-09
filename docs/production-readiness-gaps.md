# req2ado — Production Readiness: Missing Capabilities

Cross-checked against `docs/architecture.md` (the original planning deliverable) by direct code inspection, not self-report. Scope: Phases 0–9, merged to `master`.

**Purpose of this file:** track what still needs to be built or wired before this app is a complete match for the original request. Verified/working capabilities are omitted here by design — see `docs/architecture.md` for the full spec. This file is gaps only.

**On abstraction:** this build never contains real company/customer specifics (mock ADO backend, synthetic test fixtures, runtime-discovered field names instead of hardcoded ones). That is intentional and is **not** listed as a gap anywhere below — every item here is a genuine capability gap, independent of data sensitivity.

---

## Blockers (fix before calling this feature-complete)

- [ ] **SURVEY mode is not reachable through the running product.**
  Real, tested logic exists (`ingestion/app/survey/`, `ingestion/app/leveling/llm_leveling.py`), but the live job pipeline (`orchestrator/src/modules/pipeline/pipeline.worker.ts`) only ever calls the BASELINE path. Nothing wires the generative "shall"-requirement path into an actual job today.
  **Impact:** the whole informal-notes-to-formal-requirements use case is unusable end-to-end, even though every piece of it individually works.

- [ ] **Embedding-based dedup is not reachable through the running product.**
  Same shape as above — `ChromaVectorStore` and the ≥0.90 near-duplicate check are built and unit-tested, never invoked by the live pipeline.
  **Impact:** live dedup today is exact-hash only (Postgres `IdempotencyMapping`). Two requirements that are *semantically* the same but not byte-identical will both get written — no near-duplicate protection in production.

- [ ] **No session persistence — PAT re-entry required every page load.**
  By design the PAT is never stored anywhere (correct security posture), but there is currently no session-restore affordance at all — a browser refresh mid-job forces a fresh login.
  **Impact:** may be fine as-is, but confirm this matches the intended operator workflow before wider rollout — it's a real UX gap, not just a security feature.

---

## Gaps (real, not yet built)

- [ ] **No SSE / real-time job progress.** Frontend polls `GET /jobs/:id` every 2s. The architecture's own system diagram and GUI spec call for a pushed progress stream. Functionally fine at current scale; will not hold up if job counts or polling frequency grow.

- [ ] **No write-failure recovery.** If an ADO write throws partway through `confirm()`'s create/link loop, the job is left permanently stuck in `writing` status — no rollback, no re-confirm path, no audit entry explaining what happened. Already-created items are safely recorded (idempotency won't duplicate them on a hypothetical retry), but there is currently no retry mechanism at all.

- [ ] **No session-JWT guard on job routes.** `JobsController.submit()` hardcodes `userId: 'placeholder-user-id'` — the JWT-verification guard (`SessionService`) exists but isn't wired as a route guard on anything except `/auth/login`. Every job today is attributed to the same placeholder identity regardless of who's actually logged in.

- [ ] **No `deploy/` folder or reverse proxy.** `docker-compose.yml` exists and is verified end-to-end (6 real services boot and pass a live golden test), but there's no nginx layer, no TLS termination config, no production deployment topology beyond bare compose.

- [ ] **`shared/` type generation isn't wired.** JSON Schema files exist as the intended single source of truth (`shared/schemas/*.json`), but nothing generates TypeScript or pydantic types from them yet — cross-language type drift between `orchestrator`/`mcp-ado-server` (TS) and `ingestion` (Python) is possible today and would go undetected.

- [ ] **Vision LLM unimplemented.** `LlmClient.vision()` throws `not implemented`. Scanned diagrams/figures get a `[FIGURE: caption]` text placeholder only — no actual image content extraction.

- [ ] **Config-override path for Customer ID field resolution.** The runtime candidate-list resolution works (verifies against `ado_discover_fields`), but the documented "operator can explicitly override via config" step isn't wired — there's no `fields.customer_id`-equivalent config surface yet. Only matters if a target ADO project's real Customer ID field name doesn't match any of the three known candidates.

---

## Missing pages / UI surface

- [ ] **No standalone Preview, Results, or Settings pages.** Diff preview and results are folded into the JobStatus page rather than split out per the original repo skeleton. Functionally covers the same ground today, but if a richer results view or a settings/admin surface is needed later, that's net-new UI work, not a wiring fix.

---

## Docs still missing

- [ ] `docs/runbook.md`
- [ ] `docs/api.md`
- [ ] `docs/prompts.md`
- [ ] `docs/security.md`

(`docs/architecture.md` and `docs/user-guide.md` exist and are current.)

---

## Not yet exercised end-to-end (blocked on external access, not code)

- [ ] **Live write against a real on-prem ADO tenant.** Every precondition is now met in code (per-request PAT credential flow traced end-to-end from login through to the real HTTP client, real field content, parent/child linking, CA-trust TLS) — the actual round-trip against a real server has not been run in this environment because it has no ADO access. This is the next concrete thing to test once you have real on-prem access: `curl -u :<PAT> "{ADO_BASE_URL}/_apis/connectionData?api-version=7.1"` as a pre-flight, then a real login → upload → confirm cycle through the UI.

---

## Summary counts

| Category | Count |
|---|---|
| Blockers | 3 |
| Gaps | 7 |
| Missing UI surface | 1 (bundling 3 pages) |
| Missing docs | 4 |
| Untested end-to-end (environment-blocked, not code) | 1 |
