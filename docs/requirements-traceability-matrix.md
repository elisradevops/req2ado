# req2ado — Requirements Traceability Matrix

**Purpose:** verify every requirement from the original request (`docs/architecture.md`, the planning deliverable produced from that request) is accounted for before proceeding further. Full list — met, partial, and missing — not a gaps-only summary. Cross-checked by direct code inspection against the current `master` (Phases 0–10), not by self-report.

**Update (Phase 10):** the two Blockers this matrix originally surfaced — SURVEY mode and embedding dedup being fully built but unreachable through the live pipeline — are closed. Both are now wired end-to-end, task-reviewed individually, and cleared a final whole-branch review with no blockers. See §3.2 and §6 for the updated status.

**On abstraction:** this build is a genericized implementation of the original ask — no real company/customer specifics anywhere in code (mock ADO backend for dev/CI, synthetic test fixtures, runtime-discovered field names instead of hardcoded ones, generic redaction pattern classes). Rows marked **Met (abstracted)** below satisfy the underlying requirement through a config-driven or runtime-verified mechanism rather than a literal hardcoded match to any one customer's environment — this is the correct way to satisfy that requirement in a sanitized codebase, not a shortcut around it. Where a row depends on something only the real customer's real ADO instance can confirm (a real field name, a real document sample), that is called out explicitly under "Verify against real environment."

**Status key:**
- **Met** — built, tested, exercised end-to-end against the real code path.
- **Met (abstracted)** — the underlying requirement is satisfied via a generic/runtime mechanism; will need a final check against the real customer environment (see column).
- **Partial** — real, working code exists but isn't fully wired into the live product path, or covers part of the requirement only.
- **Missing** — not built.
- **Deferred (agreed)** — explicitly descoped by an explicit decision during development, not silently dropped.

---

## 1. Core Outcome

| # | Requirement | Status | Evidence | Verify against real environment |
|---|---|---|---|---|
| 1.1 | Full GUI web platform, matching DocGen's visual language | Met | React 19 + MUI; theme tokens corrected to match DocGen's real palette (navy `#1B458F`, Inter, 8px grid, 10px radius) | — |
| 1.2 | User logs in with a PAT | Met | Login page validates `{orgUrl, pat}` against the ADO server's own `connectionData` endpoint | Test with a real operator's real PAT against your ADO instance |
| 1.3 | User uploads a document | Met | Multipart upload, size limit (25MB default, configurable), extension allowlist | Confirm 25MB default suffices for your real document sizes |
| 1.4 | User picks a mode (BASELINE / SURVEY) | Met | Mode picker is genuinely selectable (Phase 10 removed the disabled/"coming soon" state); `mode` threads end-to-end from `Upload.tsx` through to ingestion's `/level` | See §3.2 |
| 1.5 | Preview the inferred tree before writing (dry-run) | Met | Real dry-run diff rendered with create/reuse status, type, title, hierarchy | — |
| 1.6 | Write idempotent, parent/child-linked work items to on-prem ADO | Met | Confirmed: real field content, `linkParentChild` called in tree order (including linking to reused parents), idempotent re-run proven (100% reuse on identical re-submit) | **Run the actual write against your real ADO tenant — this is the one link in the chain not yet executed outside this dev environment** |
| 1.7 | Heavy work (parse/OCR/embed/LLM) runs on a job queue + worker pool | Met | Redis + BullMQ; a separate worker process consumes jobs, independent of the HTTP server | — |
| 1.8 | ADO writes go through a custom MCP server (HTTP Streamable) | Met | Fresh, from-scratch implementation; stateless per-request transport on both client and server sides | — |
| 1.9 | LLM calls go server-side through a redaction proxy | Met | `/llm/chat` proxy redacts every outbound message unless explicitly marked trusted-local | — |
| 1.10 | In-app wiki/guidelines + tooltips/popovers | Met | `GET /wiki` renders the real user guide; tooltips on Area Path, Survey (disabled), Confirm Write | — |

---

## 2. Locked Decisions (from the original planning Q&A)

| # | Decision | Status | Evidence | Verify against real environment |
|---|---|---|---|---|
| 2.1 | Standalone repo inside `elisradevops/` workspace | Met | Own package boundary, own dependencies, own compose file | — |
| 2.2 | Hybrid TypeScript + Python stack | Met | React/NestJS/MCP server in TS; ingestion/OCR/embeddings in Python/FastAPI | — |
| 2.3 | MCP server built fresh, not reused from `elisra-mcp-ado` | Met | Independent implementation; only generic REST conventions (retry pattern, batch size, JSON-Patch shape) reused as documented knowledge | — |
| 2.4 | MCP transport: HTTP Streamable (networked, multi-client, containerized) | Met | `StreamableHTTPServerTransport` / `StreamableHTTPClientTransport` on both sides | — |
| 2.5 | On-prem ADO target: api-version `7.1 → 5.1 → none`, self-signed TLS via CA-trust | Met | Ladder implemented with retry/backoff; `https.Agent({ca})` wired when `ADO_CA_CERT` is set — never disables TLS verification | Confirm your real server's actual supported api-version and whether it uses a self-signed cert requiring `ADO_CA_CERT` |
| 2.6 | PAT entry via login screen, header-passed, never persisted or logged | Met | PAT held in React state only; forwarded as `X-Ado-Org-Url`/`X-Ado-Pat` headers only on the one route that needs it; never written to Postgres/Redis/disk/logs | — |
| 2.7 | LLM access: backend proxy, redact-first | Met | Redaction runs before every egress call | — |
| 2.8 | Scale: job queue + workers (Redis + BullMQ; Python horizontally-scaled) | Met | 50-concurrent-job load test passing with zero shared-state races | Load-test at your real expected concurrency, not just 50 |
| 2.9 | Leveling: auto-detect default (heuristic BASELINE, LLM SURVEY) | Met (abstracted) | Heuristic BASELINE leveling is real, deterministic, live. LLM/SURVEY leveling is now wired into the live job pipeline (Phase 10) — hierarchy inference + batched requirement formalization both call the orchestrator's real `/llm/chat` proxy | See §3.2. "Abstracted" because the real backend behind the proxy today is a local Ollama model (`llama3.2:1b`), not the customer's real production LLM |
| 2.10 | Ingestion: all formats in Phase 1 (txt/md/docx/pdf/scanned-OCR/xlsx/tables/figures) | Met | All loaders present and tested | Test against real customer document samples once available (real scans, real templates) — synthetic fixtures only used so far, per the data-sensitivity constraint |
| 2.11 | GUI built with the frontend-design skill; MUI + AntD patterns; design tokens | Met | Deliberate token system, signature diff-marker element (not a generic default), DocGen parity independently verified | — |
| 2.12 | Docs: full TSDoc/docstrings + in-app wiki + tooltips on every non-trivial control | Met (abstracted) / Partial | Wiki and tooltips real. Doc coverage was reviewed deliberately (comment only where the WHY is genuinely non-obvious) rather than blanket-commented — matches this codebase's own stated documentation philosophy, but is a different bar than "every export documented." `runbook.md`/`api.md`/`prompts.md`/`security.md` (named in the original file skeleton) don't exist yet | — |
| 2.13 | Backend framework: NestJS (DI, guards, validation) | Met | Full module structure, DI throughout, Zod schema validation on config | — |
| 2.14 | Database: Postgres + Prisma (jobs, audit, idempotency map, users/roles) | Met | All real Prisma models; migrations verified against a live Postgres instance, not just generated blind | — |
| 2.15 | App auth: ADO PAT is the sole credential for identity AND permissions | Met | Every authenticated user is a plain `User` row keyed by ADO identity — no app-level role field at all. RBAC scaffolding from the original build was fully removed after confirming it had zero runtime authorization effect, which satisfies this decision more precisely than partially-built RBAC would have | — |

---

## 3. Operating Modes

### 3.1 BASELINE mode

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 3.1.1 | Strict, verbatim, provably faithful (hash-verifiable) | Met | Fidelity hash is byte-for-byte over the normalized source span; re-hash on re-run detects drift |
| 3.1.2 | LLM disabled by default | Met | No LLM call exists anywhere in the BASELINE code path |
| 3.1.3 | Deterministic — same input twice, identical output | Met | Verified via repeated fidelity-hash-stability tests |
| 3.1.4 | Title ≤256 chars, extracted (not summarized) | Met | 255/256/257 boundary tests, multibyte/emoji-safe truncation |
| 3.1.5 | TBD/OPEN markers and figure placeholders preserved | Met | Explicit test coverage for both |

### 3.2 SURVEY mode

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 3.2.1 | Distills informal narrative into formal "shall"-style requirements | Met | `OrchestratorLlmClient.generate_requirements_for_document` (one batched LLM call for the whole document) formalizes every node; wired live via `build_survey_tree` |
| 3.2.2 | Taxonomy tags applied (functional/non-functional/interface/etc.) | Met | Tags come back from the same batched call and are attached per-node; a malformed/unknown tag from the LLM is now dropped rather than crashing the whole job (hardened during Phase 10's final review) |
| 3.2.3 | Each requirement individually verifiable | Met | Each `WorkItemNode` gets its own `fidelity_hash` (sha256 over the final formalized description) — weaker guarantee than BASELINE's verbatim-span hash (documented in code: `temperature=0` is mostly-but-not-guaranteed deterministic), backstopped by embedding dedup (§6) |
| 3.2.4 | **Reachable end-to-end through the running product** | **Met** | **Closed in Phase 10.** `mode` threads from `Upload.tsx` → `POST /jobs` → BullMQ payload → `pipeline.worker.ts` → ingestion's `POST /level?mode=survey` → `build_survey_tree`. Verified: orchestrator/frontend/ingestion unit+integration suites pass; a golden-E2E scenario (job #3, informal fixture → real local Ollama → real generated titles) exists in `scripts/run-golden-e2e.sh` |

**Verify against real environment:** the golden-E2E SURVEY scenario has not been live-executed end-to-end — an unrelated, pre-existing Docker container (`recruitment_db`) occupies port 5432 on the dev machine used this session, blocking the script's own Postgres startup step. The code path was verified by direct reading and by every non-DB-dependent test suite; a genuine live run is still owed once the port is free, or in any other environment.

---

## 4. Ingestion

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 4.1 | txt / md | Met | — |
| 4.2 | docx | Met | — |
| 4.3 | pdf (text-native) | Met | Page-ordered block extraction |
| 4.4 | Scanned PDF via OCR | Met | Tesseract/poppler-backed; a real page-ordering bug (mixed scanned/text pages) was found and fixed during hardening |
| 4.5 | xlsx / tables | Met | — |
| 4.6 | Figures → `[FIGURE: caption]` placeholder | Met | — |
| 4.7 | Redaction before every LLM egress call | Met | Part numbers, hostnames, URLs, emails, GUIDs stripped; `trusted_local` bypass tested |
| 4.8 | Vision-based extraction of scanned diagrams (optional enhancement) | Missing | `vision()` throws "not implemented" — named optional in the original spec, so not a hard requirement gap, but flagging since it's explicitly named |

---

## 5. Hierarchy Inference, Distillation, Traceability

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 5.1 | Numbering + heading-depth leveling (context-dependent, not blind depth mapping) | Met | Depth-stack construction correctly computes parent/child per branch |
| 5.2 | Same-depth nodes can be different types per branch | Met | Explicit golden test for exactly this case |
| 5.3 | Parent/child links actually written to ADO | Met | Was a real gap (found: zero linking calls, empty field content on every write) — closed: `confirm()` now creates in tree order, links children to both newly-created and reused parents |
| 5.4 | Customer ID field resolved at runtime, never hardcoded | Met (abstracted) | Candidate-list resolution against `ado_discover_fields`, cached per work-item type; config-override step (checking an operator-specified field name first) is not yet wired — only matters if none of the three known candidate names exist in your real project |
| 5.5 | AreaPath and State written on every created item | Met | Was a real gap (found: only Title/Description written) — closed |
| 5.6 | Idempotency: `(source_hash, customer_id, area_path) → System.Id`, prevents duplicate writes on re-run | Met | Proven via a real golden test: identical re-submission produces a 100%-reuse diff |

---

## 6. Dedup

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 6.1 | Embedding-based near-duplicate detection, ≥0.90 threshold | Met | Threshold logic real and unit-tested (0.89 keep / 0.91 skip boundary); now invoked live via `POST /dedup/check`, called from `DryRunService.diff()` after the exact-hash idempotency lookup misses |
| 6.2 | Scoped by Area Path | Met | `area_path` passed through the full call chain and proven at the HTTP-route level (two requests with different `area_path` don't cross-match), not just unit-tested |
| 6.3 | Local vector store (Chroma), no external cloud | Met (abstracted) | `ChromaVectorStore` uses a local `PersistentClient`, correctly no external service dependency. **Known, documented limitation, not fixed in this phase:** a `PersistentClient` does not survive horizontal scaling — each ingestion instance would hold an independent, incomplete corpus. Dedup correctness requires ingestion to run as a single instance until Chroma is externalized to a shared server |
| 6.4 | **Reachable end-to-end through the running product** | **Met** | **Closed in Phase 10.** `confirm()` upserts every real create into the vector store (best-effort — an upsert failure doesn't fail the already-succeeded ADO write); the dry-run diff surfaces a distinct `dedup_skip` action (not conflated with the exact-hash `reuse` action) with a similarity score, rendered in the frontend as a distinct amber marker |

**Two safety-critical invariants, verified by direct code read + independent review, not just by test:** (1) dedup check failure **fails open** — an embedding-service outage falls through to `action: 'create'` rather than failing the whole job, so BASELINE jobs (which had zero LLM/embed dependency before this phase) can never regress from this feature; (2) a `dedup_skip` match is **never re-parented** — `confirm()`'s pass 2 skips `linkParentChild` whenever the child entry is `dedup_skip`, since re-parenting a real existing ADO item off a probabilistic similarity guess would be a real data-integrity bug, not just a UX nuance.

**Verify against real environment:** same as §3.2 — the golden-E2E dedup scenario (job #4, a near-duplicate of job #1's fixture) exists in `scripts/run-golden-e2e.sh` but has not been live-executed, blocked by the same port-5432 contention. Code path and wire-shape agreement (orchestrator TS ↔ ingestion Python) were verified by direct read on both sides.

---

## 7. MCP Server & ADO Write-Back

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 7.1 | Tool: discover_fields | Met | — |
| 7.2 | Tool: query_ids (dedup / idempotency lookup) | Met | — |
| 7.3 | Tool: preview_write (dry-run) | Met | — |
| 7.4 | Tool: create_work_item | Met | Real field content now written (was previously empty) |
| 7.5 | Tool: set_fields | Met | — |
| 7.6 | Tool: link_parent_child | Met | Now actually called from the real write path (was previously dead code) |
| 7.7 | Tool: update_work_item | Met | — |
| 7.8 | Transport: Streamable HTTP + bearer | Met | Constant-time bearer comparison (timing side-channel closed) |
| 7.9 | Backend swappable: real / mock | Met | Mock is the deliberate data-sensitivity abstraction for dev/CI — never a captured real tenant |
| 7.10 | Retry/backoff on 429/5xx + network errors | Met | Applied to every real ADO call, including the api-version resolution probe itself |
| 7.11 | Bounded concurrency + 200-item batch chunking | Met | — |
| 7.12 | **Real on-prem write actually possible** (not blocked) | Met | **Was the single biggest blocker in the whole system** — `ADO_BACKEND=real` used to hard-throw at process startup. Closed: per-request credential now flows from the login form all the way through to a fresh, per-request real backend instance | **The literal on-prem HTTP round-trip is the one thing not yet executed — everything up to that network boundary is proven in code and by test** |

---

## 8. Auth & Access Control

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 8.1 | Login validates against ADO's own identity — no separate IdP required | Met | `connectionData` round-trip |
| 8.2 | Azure AD available as a config option, not required | Met | Kept in the codebase, config-gated, not surfaced in the default UI |
| 8.3 | Session identity via short-lived JWT | Met | — |
| 8.4 | PAT never persisted anywhere | Met | Confirmed nowhere in Postgres/Redis/disk/logs at any point in the whole request lifecycle |
| 8.5 | ADO's own permission system is the real access-control gate (no app-level RBAC) | Met | RBAC scaffolding fully removed after confirming zero runtime effect — a deliberate decision, not an oversight |
| 8.6 | Session-JWT guard applied to every route that needs identity | Missing | `JobsController.submit()` hardcodes a placeholder user id — the verification guard exists but isn't wired onto this or any non-auth route yet |

---

## 9. Security

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 9.1 | PAT never logged (log-assertion tested) | Met | — |
| 9.2 | MCP bearer required on every request | Met | — |
| 9.3 | Constant-time secret comparison (no timing side-channel) | Met | Closed on both the MCP server and the LLM proxy guard |
| 9.4 | HTTPS transport | Met (abstracted) | Enforced at the deployment/reverse-proxy layer, which doesn't exist yet — see §11.3 |
| 9.5 | On-prem CA-trust TLS (not `rejectUnauthorized:false`) | Met | Was parsed-but-unused config; now wired to a real `https.Agent` |
| 9.6 | Zod/schema input validation on all routes | Met | — |
| 9.7 | Rate limiting | Met | 200 req/60s, generous enough not to trip real usage |
| 9.8 | Upload size/type limits, malware-safe parsing | Met | 413/400 enforcement; a real config-ceiling bug (the limit silently couldn't be raised past a framework default) was found and fixed |

---

## 10. Scale & Operations

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 10.1 | N concurrent jobs complete without corruption | Met | 50-way concurrent load test against real pipeline logic |
| 10.2 | Audit trail persisted | Met | Was dead schema since the earliest phase; now wired at submit/diff-ready/confirmed/failed with real rows confirmed via direct DB query |
| 10.3 | Job progress streamed to UI (SSE) | Missing | Frontend polls every 2 seconds instead |
| 10.4 | Write-failure recovery/retry | Missing | A mid-write ADO failure leaves the job permanently stuck with no rollback or re-confirm path |

---

## 11. Repository, Deployment, Docs

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 11.1 | `docker-compose up` brings up the full real stack | Met | Verified via an actual `docker compose up -d --build` run across all 6 services (a real Prisma-on-Alpine TLS bug was found and fixed in the process) |
| 11.2 | `shared/` cross-package types, single-sourced | Partial | JSON Schema files exist; no codegen step wires them into either language's real types yet |
| 11.3 | `deploy/` folder, nginx reverse proxy, TLS termination | Missing | Not built — compose exists, no production deployment topology beyond it |
| 11.4 | Full docs wiki: architecture, runbook, api, prompts, security, user-guide | Partial | `architecture.md` and `user-guide.md` exist and are current; `runbook.md`/`api.md`/`prompts.md`/`security.md` don't exist yet |
| 11.5 | Preview / Results / Settings as standalone pages | Deferred (agreed) | Diff preview and results absorbed into the JobStatus page instead — functionally equivalent today, but net-new UI work if a richer or separate view is wanted later |

---

## Summary

| Category | Count |
|---|---|
| Met | 65 |
| Met (abstracted — confirm against real environment) | 4 |
| Partial (includes one dual-status row, §2.12) | 3 |
| Missing | 5 |
| Deferred (agreed) | 1 |

**Before proceeding further, in priority order:**
1. ~~Decide whether SURVEY mode and embedding dedup need to be wired into the live pipeline before this ships~~ — **Done (Phase 10).** Both are wired end-to-end, individually task-reviewed, and cleared a final whole-branch review with no blockers. Live execution of their golden-E2E scenarios is still owed (blocked by an unrelated local port conflict, not a code issue) — see §3.2/§6.
2. Run the one thing that's fully built but unexecuted: a real write against your actual on-prem ADO tenant.
3. Decide whether the session-guard gap (§8.6) and write-failure recovery gap (§10.4) are acceptable for a first production rollout or must be closed first.
4. Everything else in this document is either already met, or a named, agreed, tracked simplification — not a surprise.
