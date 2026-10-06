# Job transparency — current-state review (SURVEY mode)

Status: review only, no code changed. Date: 2026-10-05.
Companion: [`job-transparency-design.md`](job-transparency-design.md).

Scope is SURVEY mode. BASELINE runs no LLM by default, so most of this review does not apply to it. The stepper already shows it a shorter step list (`JobLifecycleSteps.tsx`, `BASELINE_STEPS`).

The goal being reviewed against: while a job runs, the user should be able to answer these questions:
- What is it doing now, and why?
- How far along is it?
- What limits apply to this run?
- How many tokens has it used so far?
- Has anything been skipped or degraded?

The view is read-only. There is no raw prompt or response inspector.

All paths are relative to `req2ado/`. Line numbers are as of this review. Anything marked *(unverified)* rests only on a sub-agent's skim.

---

## 1. End-to-end flow map

```
Browser                Orchestrator (NestJS)                         Ingestion (FastAPI)                  LLM backend
───────                ──────────────────────                        ───────────────────                  ───────────
NewJobWizard ─submit─▶ JobsService  queue.add('ingest-and-level')
  navigate(/jobs/:id)   jobs.service.ts:344 (BullMQ, no attempts/backoff)
                        │
                        ▼  pipeline-worker.main.ts:91 (sandboxed processor)
                       runPipelineJob  pipeline.worker.ts
                        ├ status=running, model persisted ...... :441
                        ├ publish stage 'parse' ................ :443
                        ├ POST /ingest (1 h timeout, no retry) . :585 ──▶ parse, OCR, vision ─────────────▶ /llm/vision (orch proxy)
                        │                                                 narration: describe_figure, table_detected,
                        │                                                 page_alignment, parse_done ──▶ Redis
                        ├ publish 'infer_hierarchy_start' ...... :693
                        ├ POST /level (1 h timeout, no retry) .. :702 ──▶ main.py:1413 → _resolve_caps (num_ctx) main.py:1467
                        │                                                 build_survey_tree llm_leveling.py:1578
                        │                                                   preparing_analysis ............ :1808
                        │                                                   deterministic subtrees ........ :1207 (deterministic_subtree)
                        │                                                   split/merge by coverage budget  :2070-2093
                        │                                                   Stage 1 skeleton per branch ... (build_skeleton) ─┐
                        │                                                     agentic query_kb ≤4 rounds    orch_llm_client:250│
                        │                                                   root regroup (SILENT) ......... :2395-2410        │  every call:
                        │                                                   Stage 2 figure/table mapping .. (map_scope)        ├─ POST orch /llm/chat
                        │                                                   Stage 3 author per branch ..... (analyze_section,  │  (redact → upstream)
                        │                                                                                    section_complete) │
                        │                                                   scoring chunks scoring.py:125 . (score_requirements│
                        │                                                                                    _done, chunk_warning)
                        │                                                   conflicts ..................... (detect_conflicts)  │
                        │                                                   trace links ................... (infer_trace_links)┘
                        │                                                   finalize_warnings warnings_finalize.py:234
                        │                                                 ◀── WorkItemTree {nodes, warnings, kb_citations, ...}
                        ├ publish 'generate_requirements_done' . :710
                        ├ publish 'dedup_check' + per-item narration :896/:913 (POST /dedup/check per item)
                        ├ status=diff_ready, Job.warnings ...... :1011 ; DedupSkipAudit :1072 ; publish 'diff_ready' :1082
                        └ cancelled :1092 / failed :1123
Review (JobDetail) ─confirm─▶ JobsService.confirm → status 'writing', narration phase 'writing' + writeSubPhase
```

**Event path.** Ingestion and the orchestrator both publish to Redis pub/sub `job-events:{jobId}`.
- Ingestion publishes directly, at `narration_publisher.py:590-594`. The orchestrator publishes at `job-events.publisher.ts:78-145`.
- Each publisher also keeps a replay list, `:narration-log`, trimmed to 50 entries with a 3600 s TTL (`job-events.publisher.ts:74,141-142`), and a `:current` stage key.
- `JobEventPersistenceService` `psubscribe`s to `job-events:*` and inserts one `JobEvent` row per message (`job-event-persistence.service.ts:80,159`).
- `GET /jobs/:id/events` (SSE) relays live messages and replays from Redis. `GET /jobs/:id/event-history` returns all rows, unpaginated (§14 of DESIGN.md makes this deliberate).
- The frontend merges both feeds: `mergedNarrations`, `JobDetail.tsx:506-515`.

### Per-phase: what the system knows vs what reaches the UI

| Phase (user term) | What it is trying to do (plain language) | LLM call kind | Known internally | Reaches UI today |
|---|---|---|---|---|
| Queued | Wait for a worker | none | queue position *(unverified)* | Alert "Queued — waiting for a pipeline worker…" (`JobDetail.tsx:1632`) |
| Parse | Read the file and split it into blocks; describe figures | vision per figure | figure i/n, caption status (`insignificant`/`vision_failed`), vision on/off | `describe_figure` with figure i/n and caption; `parse_done` counts. Vision **off** is only a tree warning at diff_ready (`main.py:1285-1320`). `vision_failed` is not rendered *(per A)* |
| Prepare | Split into processing sections that fit the model's budget; fetch KB context | none / KB retrieval | branch count, coverage budget, caps source (table, live, or static default) | Only `preparing_analysis` with a static sentence. The budget, the section count rationale and the caps source are not shown |
| Deterministic subtrees | Draft text for headings that already carry IDs | title/tags, leaf synthesis, parent summaries | subtree i/n | `deterministic_subtree` with a chunk tracker |
| Stage 1 skeleton | Decide each section's Epic/Feature/Requirement structure | `section_skeleton` (agentic with `query_kb` ≤ 4 rounds when tools are supported) | tool rounds, queries, empty results, `finishReason` | `build_skeleton` with "section i of N" and KB citations. Tool activity, rounds and truncation are not shown |
| Root regroup | Group orphan top-level items by topic | `group_root_topics`, `assign_leftover_roots` | success or failure | **Nothing.** Deliberately silent (`llm_leveling.py:2395-2410`). A failure is logged only (`root_regrouping.py:102`) |
| Stage 2 mapping | Attach figures and tables to work items | `map_figures_tables` | batches | `map_scope` (indeterminate) |
| Stage 3 authoring | Write requirement text per section | `author_content` | `finishReason=length` → `OUTPUT_TRUNCATED` (`llm_leveling.py:4079`) | `analyze_section`, then `section_complete` with nodes. Truncation surfaces only at diff_ready |
| Scoring | Judge each requirement's wording quality | `score_requirements_for_document`, `score_epics_and_features…` | chunk i/n, failures | Batch i/n and issues found. A failed chunk raises a live `chunk_warning` (`scoring.py:320,487,805,842`) |
| Conflicts | Find near-duplicates that disagree | embeddings + `judge_duplicate_cluster` | embed/judge failures | `detect_conflicts` (indeterminate). Failures are logged only (`conflict_detection.py:128,193`) |
| Trace links | Infer coverage links | `infer_trace_links` | failures → `TRACE_LINK_INFERENCE_FAILED` | `infer_trace_links` with sample titles |
| Dedup check | Compare each proposed item with existing ADO items | embeddings | similarity, skips (`DedupSkipAudit`) | "Checking N of M proposed items…" |
| Review / Write | Human approval, then the irreversible write | none | per write sub-phase | `WriteSubStepper` with "N of M written" |

---

## 2. Token usage

**Finding: token usage is not captured anywhere, on any path.**

- **Orchestrator non-streaming.** `toResult` returns only `content`, `toolCalls` and `finishReason`. `response.usage` is dropped (`orchestrator/src/modules/llm/openwebui.client.ts:233-237`). All three retry rungs return through the same `toResult` (`:256-285`).
- **Orchestrator streaming.** The loop reads only `delta.content` and `delta.reasoning` (`openwebui.client.ts:462-468`). `stream_options.include_usage` is never requested, so OpenAI-compatible servers send no usage chunk, and any usage-only chunk would be skipped by `if (!delta) continue`.
- **Contract.** `LlmChatResult` has no usage field (`llm-client.interface.ts:41-46`). `vision()` returns a bare `string` (`:136`).
- **Ingestion** knows about the gap and says so in its comments. It sets only `gen_ai.request.model` and `gen_ai.operation.name` on OTel spans. See `ingestion/app/survey/orchestrator_llm_client.py:1225` ("LlmChatResult doesn't forward `usage` yet") and `:1837-1840` ("a real gap tracked separately… usage passthrough is its own small follow-up").
- **Persistence.** There is no token or usage column on `Job` or `JobEvent` (`orchestrator/prisma/schema.prisma:56+, 269-280`). Nothing is aggregated per call, phase or job.
- **The only token numbers anywhere are estimates for budgeting.** These are `_estimate_tokens` in `llm_leveling.py:122` and the static caps in `model_caps.py`.
- **Cache hits.** These are Redis-backed with a 24 h TTL (`llm_cache.py:15`). Hits are known only as log lines ("cache hit, skipping LLM call", at six sites in `orchestrator_llm_client.py`). A hit costs 0 tokens, and a future meter must count it as such.
- **Retries.** Ingestion retries 429 and 5xx up to 3 attempts, with backoff of 2 s then 8 s (`orchestrator_llm_client.py:125-138, 955-980`). The orchestrator's ladder adds up to one extra call per rung. When usage is captured, each attempt that reached the model is billed by the backend and must be counted.
- **Reasoning models.** Reasoning *text* is streamed (`delta.reasoning`), but reasoning *token* counts (e.g. `completion_tokens_details.reasoning_tokens`) are never read.
- **Agentic loop.** One logical "analyze section" call can be up to 4 HTTP calls (`_MAX_TOOL_ROUNDS = 4`, `orchestrator_llm_client.py:250`). Usage has to be summed across rounds.

---

## 3. Limits and degradations the system knows but the user never sees

| Condition | Detected at | Logged | In `tree.warnings` | Live event | UI |
|---|---|---|---|---|---|
| Context window resolution: model table, frontier prefix, live `/api/show`, or **static default 28k / coverage 10k** | `model_caps.py:180-209`; used as `num_ctx` at `main.py:1466-1468` | **No.** A lookup failure returns the default silently (`except Exception: return static_default`) | no | no | no |
| Coverage budget drives section splitting | `llm_leveling.py:2070-2093`; budget `_COVERAGE_BUDGET_TOKENS = 10_000` (`model_caps.py:46`) | partly | no | Only branch i/N | "Section i of N" (an InfoTip admits a section is a processing chunk) |
| Output cap reached (`finishReason=length`) for analyze, skeleton or author calls. Default `_MAX_OUTPUT_TOKENS = 20000` | `orchestrator_llm_client.py:94, 1850` (+ skeleton/author sites) | warning | **yes**, `OUTPUT_TRUNCATED` (`llm_leveling.py:3088, 4079`) | **no** | Only after diff_ready, in CollapsibleWarnings |
| Agentic rounds exhausted, so the branch gets 0 nodes | `orchestrator_llm_client.py:2464-2470` | warning | indirectly, as `ZERO_NODES` | no | diff_ready only |
| Temperature-constraint retry, unsupported-params retry, schema-less fallback (one rung each) | `openwebui.client.ts:82-120, 256-285` (also stream `:429-455`, vision `:873-888`) | `console.warn` only | no | no | no |
| Ingestion 429/5xx retry (3 attempts) | `orchestrator_llm_client.py:955-980` | warning | no | no | no |
| Root regrouping failed | `root_regrouping.py:102` | warning | **no** | no | no |
| Conflict-detection embedding failed, so the whole check is skipped | `conflict_detection.py:128` | warning | **no** | no | no |
| Conflict-cluster judgment failed, so the cluster is skipped | `conflict_detection.py:193` | warning | **no** | no | no |
| KB relevance verification failed, so citations are unverified | `llm_leveling.py:648` | warning | **no** | no | no |
| KB has nothing relevant, or the KB is empty | agentic tool returns "(no relevant context found)" | no | no | Only `kbGrounded=false` | "Not grounded against your knowledge base for this step". Cannot tell "KB empty" from "nothing relevant" from "KB off" |
| Scoring chunk failed | `scoring.py:306-326, 476-487, 794-842` | warning | yes, `SCORING_*` | **yes**, `chunk_warning` | live, in CollapsibleWarnings as plain text |
| Enhancement call failed or incomplete | per `narration_publisher.py:112-123` | warning | yes, `ENHANCEMENT_*` | yes, `chunk_warning` | yes |
| Vision captioning disabled | `main.py:1285-1320` | — | yes, `VISION_CAPTIONING_DISABLED` | no | diff_ready only |
| Redaction applied before the upstream call; skipped when `LLM_TRUSTED_LOCAL` | `openwebui.client.ts:189,403,480,534,761`; `redactor.ts:20-29` | no counts | no | no | no. The user cannot tell whether redaction was on |
| Request timeouts: orchestrator LLM 600 s, ingestion LLM 1800 s, ingest/level 1 h | `config.schema.ts:75,159`; `ingestion/app/config.py:76` | on failure | — | `job_failed` if fatal | The failure card shows `errorType` and last phase |
| Stage 3 authoring failure, which fails the job by design | `llm_leveling.py` (~4020, no try/except) | yes | — | `job_failed` | EmptyState "No diff was produced" plus error type, last phase and elapsed |
| Stale job auto-cancelled after 60 min with no JobEvent | `stale-job-watchdog.service.ts`; `config.schema.ts:131-132` | — | — | `cancelled` | "Cancelled before a diff was produced". The cause can look like a user cancel |

**Pattern.** Structured warnings exist and are well designed, but they arrive at diff_ready, as a verdict. The live channel carries only `chunk_warning`, as a free-text string. Everything at the LLM-client layer (retries, fallbacks, usage, the caps source, redaction) never leaves the server logs.

---

## 4. What the model is "trying to do": existing vocabulary and gaps

The vocabulary lives in three places, all hand-maintained:

1. **Ingestion `_PHASE_MESSAGES`** (`narration_publisher.py:337-354`) uses system language. Examples: "Extracting a deterministic hierarchy subtree", "Resolving trace/coverage links", "Preparing analysis -- splitting sections, retrieving context". Suffixes add counts, the model and KB grounding (`:369-480`). DESIGN.md §12 names the first example as the anti-pattern.
2. **Frontend `PHASE_SUBLABEL`** (`ProgressBanner.tsx:28-67`) is closer to user language. Examples: "Building document structure", "Scoring quality", "Checking for conflicts". It still includes "Extracting deterministic hierarchy" and "Analyzing and synthesizing requirements".
3. **Stepper tips** (`JobLifecycleSteps.tsx`) give one static sentence per step.

**Gaps.**
- **There is no "why".** Each label names the activity but never what the result is used for. For example, "Scoring quality" never says that low scores flag items for review, and the skeleton call never says that it decides the Epic/Feature/Requirement split.
- **`analyze_section` is a stale name.** It now labels Stage 3 authoring (text writing), not analysis.
- **The skeleton/author split is invisible.** Both appear as "section i of N".
- **Silent work.** The root regroup is silent, and agentic KB lookups are silent, so a single "section 4" row can hide 4 model round trips.
- **No call-kind identity.** The UI knows the phase but not which kind of call is in flight, its attempt number, or its limits.

---

## 5. Running-job UI critique (second by second, long SURVEY job)

### What a user sees

| t | Surface | Content |
|---|---|---|
| 0–N s | Ticker and alert | "Queued — waiting for a pipeline worker…", shown **twice**: ticker fallback and alert (`JobDetail.tsx:1632`, `narrationTicker.ts`) |
| parse | Stepper, ticker, banner | Parse is current. The ticker shows the latest message. The banner headline is "Describing figures", with "(figure i of n)" and a percentage from figure i/n |
| prepare | Banner | "Preparing analysis", indeterminate. There is no indication of how many sections or why |
| stage 1–3 | Banner and SectionStepList | The headline flips between "Building document structure" and "Analyzing and synthesizing requirements" for each section. The header shows a plain `NN%` (`ProgressBanner.tsx:483`). The label under the bar reads `~NN% of this section (est.)` (`:643`). It is the same number with two meanings |
| long single call | Banner | The bar is frozen. After 60 s the meta line changes to "waiting on model · last update 2m ago". The model-call clock explains "the bar moves when the call returns" |
| scoring | Banner | The unit switches from blocks to requirements, so the percentage jumps |
| tail passes | Banner | The percentage disappears. "A single whole-document pass…". ETA "Finishing up…" |
| dedup | Banner | "Checking N of M proposed items…" |
| diff_ready | Page | Tiles, tabs, and CollapsibleWarnings with all the warnings at once |

### Issues

1. **The ticker and banner duplicate each other.** The ticker sentence and the banner's sub-line are both `latest.message` (`narrationTicker.ts` → `NarrationTicker.tsx`; `ProgressBanner.tsx` header), so the same text is shown twice, about 100 px apart. The ticker is meant as *what, right now* (§11.3), and the banner sub-line wastes the place where the *why* could go.
2. **Contradictory percentage labels.** The header shows `NN%` as job progress, while the label says "of this section (est.)" (`:483` vs `:643`). The meaning also changes by phase (figures, then sections, then requirements).
3. **Six overlapping status signals:** stepper, ticker, headline, sub-line, SectionStepList and model-call clock. None of them carries limits, tokens or degradation, which are the things the user is actually missing.
4. **Silence reads as stuck.** A 5–10 minute single call shows no new event. There is also no SSE heartbeat (`job-events.controller.ts` writes only `event:` frames, with no keepalive), so a proxy idle timeout can drop the stream exactly when the user is most anxious. "Updated 4m ago" cannot tell "model is thinking" from "connection lost" from "worker died".
5. **The failure and cancel cause is ambiguous.** A watchdog auto-cancel reads like a user cancel. The cancel button is optimistic: `setStatus('cancelled')` runs before the server confirms (`JobDetail.tsx:~710-722`).
6. **Degradations are deferred.** Truncation and vision-off are known during the run but revealed only at diff_ready.
7. **New phases fail silently.** `isValidNarrationEvent` drops unknown phases with only a `console.error` (`events.ts:~287`). A backend-first deploy of a new phase makes the UI look stuck.
8. **The merge is lossy.** History is deduped on `phase|message` (`JobDetail.tsx:507-510`), so two genuinely identical messages collapse. Persistence backfill uses the same key.
9. **Accessibility.** There is no `aria-live`, `role="status"` or `role="log"` on any running surface. A grep across `ProgressBanner`, `NarrationTicker`, `JobLifecycleSteps`, `JobDetail`, `Stepper`, `ProgressBar` and `Spinner` returned nothing. Screen-reader users get no phase changes. `ProgressBar` has `role="progressbar"` but no accessible name (`ui/ProgressBar.tsx:15`). Reduced motion is handled globally (`index.css:535-539` kill switch), which satisfies §8.1.
10. **Mobile.** The meta line and ticker use `flex-wrap` and `truncate`. Truncating the ticker at 390 px hides most of a sentence that carries section labels. Behaviour at narrow width was not verified in a browser.

---

## 6. Backend event and contract plumbing

- **Contracts are hand-maintained in three packages.** They are:
  - the orchestrator's `JobStage` / `OrchestratorNarration` (`job-events.publisher.ts:4-55`)
  - ingestion's `Phase` literal and payload dict (`narration_publisher.py:27-124, 515-583`)
  - the frontend's `NarrationEvent` and runtime guard (`frontend/src/api/events.ts`)

  The only guard is `events.phase-sync.test.ts`. `shared/schemas/` holds only `canonical-doc` and `work-item-tree`. `shared/ts` generates TS only (`shared/ts/scripts/generate.mjs`, json-schema-to-typescript). There is **no Python generator**.
- **Stale stage vocabulary.** `infer_hierarchy_done` and `generate_requirements_start` are in the union but never emitted. The comment in the publisher says so.
- **Persistence.** Every message becomes one `JobEvent` insert, with the full payload in `detail` (`job-event-persistence.service.ts:148,159`). Notes:
  - `severity` is only `error` or `info`. `"warning"` is never set, even for `chunk_warning`.
  - **`JobEvent.detail` is free JSON, so new payloads need no migration.**
- **Volume.** There is no throttling or coalescing in either publisher. Concurrent branches are serialised by a lock, not rate-limited (`llm_leveling.py:2276-2291`).
- **Replay.**
  - The SSE handler subscribes first, buffers up to 50 messages, then replays `:current` plus the last 50 narrations. `mergeReplayBuffer` dedupes them (`sse-replay-merge.ts`).
  - There is no `id:` or Last-Event-ID handling.
  - A replayed terminal stage does not close the stream; only a live one does (`job-events.controller.ts:111,141`).
  - The client keeps only the last 50 live narrations (`JobDetail.tsx:439`) and backfills from `/event-history` on mount and on status change.
- **Auth.** Both endpoints 404 unless `job.userId === user.userId` (`job-events.controller.ts:63,80`), so a user only sees their own jobs. The browser uses a cookie via `EventSource(..., { withCredentials: true })`.
- **Watchdog coupling.** Staleness is the time since the last `JobEvent` (60 min default). Any new event type that is persisted also counts as liveness. This matters for heartbeat design.
- **Customer text already on the event bus.** `section_complete` carries `sectionNodes[].text` (`narration_publisher.py:549-554`), so generated requirement text is in Redis and in `JobEvent.detail`. That data is internal, not LLM-bound, but new transparency events must not add more document text.

---

## 7. Ranked findings

| ID | Sev | Effort | Finding | Evidence | Why it matters to the user |
|---|---|---|---|---|---|
| T1 | High | M | Token usage is dropped at the orchestrator client and never reaches ingestion, persistence or UI | `openwebui.client.ts:233-237, 462-468`; `llm-client.interface.ts:41-46`; `orchestrator_llm_client.py:1225, 1837-1840` | "How many tokens so far" is unanswerable, even after the run |
| T2 | High | M | LLM-layer retries and fallbacks (temperature, params, schema-less, 429/5xx) are `console.warn` or log only | `openwebui.client.ts:256-285`; `orchestrator_llm_client.py:955-980` | Slow or odd runs are unexplained, and a schema-less fallback can quietly lower output quality |
| T3 | High | S | Known degradations (`OUTPUT_TRUNCATED`, vision off, zero-node branches) are revealed only at diff_ready | `llm_leveling.py:3088, 4079`; `main.py:1285-1320` | The user learns of missing items only after the wait, with no in-run context |
| T4 | High | S | No live region on any running surface; the progress bar is unnamed | grep (none); `ui/ProgressBar.tsx:15` | Screen-reader users get no progress at all. Violates §13's intent |
| T5 | Medium | S | Context window resolution falls back silently to a 28k `num_ctx` and 10k coverage budget | `model_caps.py:205-209`; `main.py:1466-1468` | Smaller sections and lower quality with no explanation. The user cannot see which window was assumed |
| T6 | Medium | S | Four failure paths are log-only: root regroup, conflict embed, conflict judge, KB relevance | `root_regrouping.py:102`; `conflict_detection.py:128,193`; `llm_leveling.py:648` | The user believes conflicts were checked or citations verified when they were not |
| T7 | Medium | S | No SSE heartbeat; "updated N ago" conflates thinking, disconnected and dead | `job-events.controller.ts` (only `event:` writes) | The main source of "is it stuck?" anxiety on long calls |
| T8 | Medium | XS | Header `NN%` vs "~NN% of this section (est.)" for the same number | `ProgressBanner.tsx:483, 643` | Misleading progress, and it breaks §12 "never fabricate" in spirit |
| T9 | Medium | S | Ticker and banner sub-line show identical text; there is no "why" copy | `narrationTicker.ts`; `ProgressBanner.tsx` header | Wasted space. The user never learns what a step is for |
| T10 | Medium | M | Event contracts hand-copied in 3 packages; unknown phases silently dropped client-side | `events.ts:~287`; `job-events.publisher.ts:4-55`; `narration_publisher.py:27-124` | Any new transparency event risks a "stuck" UI on rolling deploys |
| T11 | Medium | S | KB state is a single boolean; empty KB, nothing relevant, KB off and tool rounds are indistinguishable | `orchestrator_llm_client.py:2472+`; `kbGrounded` | "Was this grounded in our documents?" is the key trust question in SURVEY mode |
| T12 | Low | XS | Redaction is on or off per deployment (`LLM_TRUSTED_LOCAL`), with no counts and nothing shown | `openwebui.client.ts:189,403`; `redactor.ts:20-29` | Customers handling sensitive documents cannot confirm the protection was active |
| T13 | Low | S | `phase\|message` dedupe in merge and backfill is lossy | `JobDetail.tsx:507-510`; persistence backfill | Repeated real events vanish after a reload |
| T14 | Low | S | Watchdog auto-cancel is indistinguishable from a user cancel; cancel is optimistic | `stale-job-watchdog.service.ts`; `JobDetail.tsx:~710-722` | Wrong cause in the user's head, so wrong remedy |
| T15 | Low | XS | `severity: 'warning'` is never persisted | `job-event-persistence.service.ts:148` | History cannot be filtered for problems later |
| T16 | Low | XS | Root regroup pass emits nothing | `llm_leveling.py:2395-2410` | A gap in narration and the stepper |

---

## 8. What is already there and good

- **Honest-progress discipline.**
  - `PHASE_START_WEIGHT` per-phase weighting.
  - The indeterminate fallback for tail phases ("A single whole-document pass — no fixed step count").
  - The model-call clock that admits the bar moves only when a call returns.
  - The 60 s "waiting on model" switch.

  These follow DESIGN.md §12 and are a strong base.
- **SectionStepList** answers "what is left", and keeps four permanent whole-document rows (§11.3.1).
- **The welded stepper and ticker** form a single "where / what now" object, with a guaranteed non-empty sentence.
- **A structured warning catalogue** (`WarningKind`, `workitem/model.py:340-373`) with severities, plus `finalize_warnings` grouping, an action-first CollapsibleWarnings and a reviewed state. This is the right shape to reuse for live notices.
- **Durable plus live merge.** Every event is persisted. Replay-on-reconnect and `/event-history` backfill mean a reload never regresses counts.
- **Owner-scoped event endpoints**, with the 404 check before subscribing.
- **A redact-first proxy boundary.** All LLM traffic from ingestion goes through `/llm/*` on the orchestrator, which redacts first. That makes it the natural single point to capture usage and retries.
- **`finishReason=length` is already detected** and becomes a structured warning, and truncated results are never cached.
- **`job_failed`** carries error type, last phase and elapsed time, and the failure card uses it.
- **Generic `JobEvent.detail` JSON**, so new event payloads need no migration.

---

## 9. Not verified

- **Usage fields from the deployed backend.** What it actually returns (Open WebUI, LiteLLM or Ollama OpenAI-compatible), including whether streaming returns a usage chunk with `stream_options.include_usage`, and whether reasoning tokens are reported. This needs a running stack.
- **Watchdog vs a single long call.** Whether a single call longer than 60 min (timeouts allow 30 min in ingestion, 10 min at the orchestrator) can ever trigger the watchdog in practice.
- **`JobRetentionService` and `JobEvent` rows.** Whether retention deletes them.
- **Narration volume** for a large real document (events per minute), and whether the Postgres insert rate matters.
- **Unread rendering paths.** How `figureCaptionStatus = vision_failed` and `SectionResults` render. Whether the `tickerFor` counter is rendered anywhere.
- **Responsive behaviour** at 390 px. No browser pass was done for this review.
- **`detect_conflicts` cadence** (once, or per cluster), and the exact `_SCORING_CHUNK_NODE_COUNT` and concurrency defaults.
- **The DESIGN.md §0 locked note.** Whether "Nothing has been written to Azure DevOps…" is currently present on the running screen.
