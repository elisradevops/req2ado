# Job transparency: design (SURVEY mode, read-only)

Status: **built behind flags** (all off by default); verified on the real stack and in a browser matrix. Progress, numbers
and what is still open: [`job-transparency-implementation-plan.md`](job-transparency-implementation-plan.md), section 11.
How to operate it: [`runbook.md`](runbook.md) ("Live run view"). Contracts: [`architecture.md`](architecture.md) ("Live run
view"). Decision record: [`design-decisions.md`](design-decisions.md) ("Stream the drafting calls; the stream is a view").
Evidence base for the problem: [`job-transparency-review.md`](job-transparency-review.md). Date: 2026-10-05.

This file has two parts. **Part 1 is the design as built**: counts and the document first. **Part 2 is the earlier run-ledger
proposal** (token counts, limits, typed notices), kept as the design for a later phase because tokens were made secondary.

# Part 1: the live run view, as built

## What the user asked for
A running job should show what the model is working on in the user's own document, a percentage that is counted from real
work, and, when the run finds two statements that disagree, those two side by side. Token usage is not a must-see.

## Decisions (fixed with the user)
- SURVEY mode only; read-only (no controls, no steering); no raw prompt or response inspector.
- Show the document in numbers and as an outline, plus a short excerpt (240 characters by default) of the part being worked on.
- Stream the drafting calls so items show as they are written; the stream is a view (the result still comes from the existing parse).
- The percentage is counted from finished items; each step's share of the whole is an estimate and is labelled "est.".
- Conflicts and duplicates are shown side by side with the differing words underlined (word-level longest common subsequence).
- Document types: Word, spreadsheet and CSV, text PDF, scanned PDF (page by page), plus the section path for PowerPoint, RTF, text and Markdown.
- Tokens: not on the main screen.

## What the screen shows (inside the existing progress banner)
| Part | What it answers |
|---|---|
| Document in numbers | How big is my document (words, headings, tables, figures, pages) and how many outline items are written |
| "Now" card | What the model is working on, with a short excerpt; several parts at once when chunks run in parallel; the last few finished items |
| Outline | Every item of the document, written, in progress, or waiting; read-only, virtualised, keeps the working row in view |
| Comparison | Two statements that appear to disagree, or a proposed item next to the existing work item it matches, each named by its heading and where it sits ("In: Subsystem 1 > Function 1.2") |
| Percentage | One bar: "38% of the run (est.) - 12 of 36 items in this step", with an explanation of how it is counted |
| Freshness | A long model request is called out; a lost connection raises an alert; both come from heartbeats and the stream state |

The screen never shows an internal id; it names items by their heading, and falls back to plain words ("an item", "first statement").

## How the percentage is counted
- Ingestion reports exact units per step (figures, pages, items, sections, requirements, passes). Passes that run over many chunks, and once per subtree, are summed by a per-job counter; a pass planned at zero items is skipped and its share dropped.
- The pipeline worker turns units into one weighted, never-decreasing percentage (one publisher per job). It holds at 99 until the run ends and sends 100 just before the diff is ready.
- A step that reported but never says it finished (the section skeleton, the last link pass) counts as done once a later sequential step has reported; the three drafting passes interleave and are excluded from that rule.
- The weights were measured on real runs (scoring and linking take about two thirds of a run), so they are estimates that depend on the model and hardware; the label says so. A single long model call cannot move the bar inside it unless the model emits items as it goes, and the screen says that instead of inventing progress.

## Data flow
Ingestion (map, units, live frames, finished items) to Redis, the pipeline worker (percentage), the orchestrator stream and two owner-scoped REST routes, the browser's own store, the live view. Frames are rate-limited at the source (4 a second per job) and coalesced per lane, except finished items, which are never dropped. Everything expires (24 h, 2 h).

## Privacy
Excerpts and comparison texts exist only in short-lived Redis keys and on the wire to the owner. They are not stored in Postgres and not logged; routes are owner-scoped; text is rendered as text; the model path is the local Open WebUI and Ollama. Production should keep Redis on a private network with authentication.

## Not built (see the plan)
Typed notices (output limit reached, context assumed, retries), the run summary after completion, token usage, streaming of the section-path calls, remembering per model that structured streaming is unsupported, and an option to cancel the in-flight model call.

---

# Part 2: Deferred: the run ledger (tokens, limits and typed notices)

Status: not built. This is the original proposal (written before the user made tokens secondary). It stays as the design for a later phase;
the live view above does not depend on it. Where it says "Status: proposal", read "deferred".

**Decisions already fixed by the user:**
- SURVEY mode only.
- Read-only live transparency.
- Plain-language narration plus numbers.
- No raw prompt or response inspector.
- Customer document text never needlessly exposed.

**Design headline: one *run ledger* per job.**
- Ingestion keeps a ledger of every model call: its kind, attempts, tokens, limits and outcome.
- The ledger is built from per-call metadata that the orchestrator's redact-first proxy already sits in front of.
- Ingestion publishes it as a throttled, cumulative **snapshot**. The UI always renders the latest one, so a dropped or replayed message can never make the numbers wrong.
- Discrete degradations travel as typed **notices** from a fixed catalogue, never as free text.
- The running screen adds a token count and a context limit to the existing meta line. It gives the banner's duplicated sub-line a "why" sentence instead.
- It adds one new memorable element: the **"Limits and adjustments" strip**.
- After completion, the same ledger becomes a **run summary**.

---

## (a) User-facing information model

At any moment, a user should be able to answer these questions:

| Question | Answer source | Example (copy follows §12) |
|---|---|---|
| What is it doing now? | Ticker sentence, unchanged role | "Writing requirement text for section 4 of 9 — *Power budget*" |
| Why? | Banner sub-line, new: one "why" sentence per call kind | "Each section is written separately so the model can focus on it. Text is checked for quality next." |
| How far? | The existing bar and SectionStepList, with honest labels | "38% of the run (est.)" · "5 steps left" |
| What limits are in play? | Meta line, plus the strip | "context 32k" in the meta line. In the strip: "Sections are sized to about 10,000 tokens so the model reads each one fully." |
| How many tokens so far? | Meta line, plus per-row in SectionStepList | "tokens 184,210". The value is `--` when the model server does not report usage |
| Anything degraded or skipped? | The strip, live, as typed notices | "Section 7's answer hit the model's 20,000-token output limit, so some items may be missing. They are flagged for review." |
| Is it still alive? | The freshness stamp, now heartbeat-backed | "waiting on the model · 2m 10s" vs "connection lost — reconnecting" vs "no progress for 12 min" |

**Rules carried from DESIGN.md:**
- An unknown value is `--`, never `0` (§16.23).
- An estimate says "est." or "typically" (§12).
- Model names, IDs and numbers are `font-mono` (§0.1).
- No internal standards names (§12).
- The locked note "Nothing has been written to Azure DevOps…" stays (§0).

### Data model (what the UI receives)

```ts
// shared/schemas/job-run-ledger.schema.json → generated TS
RunLedgerSnapshot {
  type: 'ledger'; jobId; seq: number;            // monotonic per job, lets the client drop stale snapshots
  emittedAt; final: boolean;
  model: { requested: string; reported?: string };          // reported = response.model if it differs
  limits: {
    contextWindowTokens: number | null;
    contextSource: 'model_table' | 'model_server' | 'frontier_default' | 'assumed_default';
    sectionBudgetTokens: number;          // coverage_budget_tokens
    maxOutputTokens: number;              // _MAX_OUTPUT_TOKENS or per-call override
    sectionCount: number | null;          // branch count once known
    toolUse: boolean;                     // supports_tools → agentic KB lookups
    vision: 'on' | 'off' | 'not_needed';
    redaction: 'on' | 'off_trusted_local';
    knowledgeBase: 'used' | 'empty' | 'not_configured' | 'unknown';
  };
  usage: {                                // reported tokens only; never estimated
    promptTokens: number | null; completionTokens: number | null;
    reasoningTokens: number | null; totalTokens: number | null;
    callsReported: number; callsUnreported: number; cachedCalls: number;
  };
  byPhase: Array<{ phase: CallPhase; calls; attempts; promptTokens|null; completionTokens|null;
                   durationMs; notices: number }>;
  bySection: Array<{ branchIndex; totalTokens|null; notices: NoticeKind[] }>;   // feeds SectionStepList
  inFlight: Array<{ callKind: CallKind; branchIndex: number|null; startedAt; attempt: number;
                    toolRound?: number }>;
  noticeCounts: Record<NoticeKind, number>;
}

RunNotice {
  type: 'notice'; jobId; seq; emittedAt;
  kind: NoticeKind;               // closed enum, see (c)
  severity: 'info' | 'warning';   // 'error' stays job_failed
  branchIndex: number | null; sectionLabel?: string;   // label already emitted today
  facts: Record<string, number | string | boolean>;    // enum/number only: { limit: 20000, attempt: 2 }
}
```

`CallKind` is a closed enum, one value per prompt family:

`describe_figure`, `subtree_titles`, `subtree_leaf_text`, `subtree_parent_summary`, `section_structure` (skeleton), `kb_lookup_round`, `regroup_topics`, `map_figures_tables`, `section_text` (author), `score_requirements`, `score_epics_features`, `judge_conflicts`, `infer_trace_links`, `judge_kb_relevance`, `enhance_text`, `embed`.

The frontend owns the plain-language copy for each value. Copy never comes from the backend, so translation and tone stay in one place and no backend text can leak document content.

---

## (b) UI surfaces and layout

### What changes, and what deliberately does not

| Surface | Today | Proposed |
|---|---|---|
| Stepper + ticker (welded) | where / what now | **Unchanged structure.** The ticker sentence comes from `inFlight[0].callKind` plus the section label when available, falling back to `latest.message`. It stays the only dark surface (§16.8) |
| Banner headline | phase label | Unchanged. Copy is revised to user language (table below) |
| Banner sub-line | **duplicate of the ticker** (T9) | The **why** sentence for the current call kind. One line on desktop, wraps on mobile |
| Banner percentage | `NN%` with a contradicting label (T8) | `NN%` plus a single label "of the run (est.)". "of this section" is removed |
| Meta line | `elapsed · model · updated` | `elapsed 17:15 · model qwen2.5:32b · context 32k · tokens 184,210 · updated 4 s ago` |
| SectionStepList rows | state glyph + label | Adds a right-aligned `font-mono text-meta` token count per section (`--` if unreported), plus a notice marker (lucide `TriangleAlert` + text "1 notice") when the section has a notice. The active row shows the call kind and attempt: "writing text · retry 2 of 3" |
| **Limits and adjustments strip** (new) | — | See below |
| CollapsibleWarnings | diff_ready verdicts plus live `chunk_warning` text | Unchanged. Live notices get the same `KIND_META` mapping, so in-run and post-run items use the same words |
| Raw activity log | superseded (§11.3) | **Still not built.** The strip is a de-duplicated index of conditions, not a stream of machine lines |

### The one memorable element: "Limits and adjustments"

This is a single row inside the ProgressBanner card, under the meta line's hairline. It is not a new card, so there is no card inside a card (§16.15).

```
desktop 1440                                                                    
┌ ProgressBanner ───────────────────────────────────────────────────────────────┐
│ ● Writing requirement text                                         38%         │
│   Each section is written separately so the model can focus on it.  of the run │
│   ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░                                       (est.)   │
│ ───────────────────────────────────────────────────────────────────────────── │
│ elapsed 17:15 · model qwen2.5:32b · context 32k · tokens 184,210 · updated 4 s │
│ ───────────────────────────────────────────────────────────────────────────── │
│ ▸ Limits and adjustments   context 32k (assumed) · sections ≤10k tokens ·      │
│                            knowledge base on · 2 notices                        │
│   (open)                                                                        │
│   ⚠ Section 7's answer hit the 20,000-token output limit. Some items may be    │
│     missing; they will be flagged for review.                    section 7     │
│   ⓘ The model server was busy, so 3 calls were retried. This added time but    │
│     not errors.                                                   3 times       │
│   ⓘ The context size could not be read from the model server, so a safe       │
│     default of 28k was assumed. Sections are smaller as a result.              │
│ ───────────────────────────────────────────────────────────────────────────── │
│ Sections  9   (i)                                             5 steps left     │
│ ✓ Section 1 · Scope                                          12,480 tokens     │
│ ✓ Section 2 · Power budget                     ⚠ 1 notice    18,002 tokens     │
│ ◉ Section 3 · Thermal  writing text · retry 2 of 3    ▬▬▬     9,114 so far     │
│ ○ Section 4 · Interfaces                                              --       │
│ … four whole-document rows (unchanged)                                          │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Collapsed** (the default once notices exist), it is a one-line summary of the limits in play plus a notice count. It is a disclosure using `ChevronRight`/`ChevronDown` (§10.1), with `aria-expanded`.
- **It auto-opens once** when the first `warning`-severity notice arrives, and never again. If the user closes it, it stays closed. The choice is stored per job in `sessionStorage`.
- **Each kind is one row**, with a count ("3 times", "sections 2, 7"). This mirrors CollapsibleWarnings' "index, not list" principle (§11.3.3). Hundreds of retries become one row.
- **Colour.** Rows use `warning`/neutral tones only. `--color-signal` is never used (§16.7). Each row carries an icon *and* a word, so colour is never the only signal (§13).
- **Motion.** A new row uses Entrance only. Counts update without a count-roll, because §8.2 reserves count roll for reviewer-driven counts.

### Copy samples (§12 voice: sentence case, cause then remedy, no jargon)

| Call kind | Headline | Why sentence |
|---|---|---|
| describe_figure | Describing figures | Figures are turned into short text so requirements can refer to them. |
| section_structure | Planning section 4's work items | The model decides which epics, features and requirements this section needs before any text is written. |
| kb_lookup_round | Checking your knowledge base | The model is looking up related material in your knowledge base to ground this section. |
| regroup_topics | Grouping loose items by topic | Top-level items that belong together are placed under a shared epic. |
| map_figures_tables | Attaching figures and tables | Each figure and table is linked to the work item that describes it. |
| section_text | Writing requirement text | Each section is written separately so the model can focus on it. Text is checked for quality next. |
| score_requirements | Checking requirement wording | Each requirement is checked for clear, testable wording. Low scores are flagged for your review. |
| judge_conflicts | Checking near-duplicates for conflicts | Requirements that say almost the same thing are compared for values that disagree. |
| infer_trace_links | Linking related requirements | Requirements that cover or depend on each other are linked. |
| (dedup, orchestrator) | Checking for duplicates | Each proposed item is compared with work items already in Azure DevOps so nothing is created twice. |

| Notice kind | Copy (cause, then what happens or what to do) |
|---|---|
| `output_limit_reached` | Section {n}'s answer hit the model's {limit}-token output limit. Some items may be missing; they will be flagged for review. |
| `context_assumed` | The context size could not be read from the model server, so a safe default of {k}k was assumed. Sections are smaller as a result. |
| `server_retry` | The model server was busy, so {count} call(s) were retried. This added time but not errors. |
| `param_adjusted` | The model rejected a setting ({param}), so the call was repeated without it. Results are unaffected. |
| `structured_output_off` | The model does not support structured answers, so replies were read as plain text. Check the proposed tree more carefully. |
| `kb_empty` | Your knowledge base has no documents for this project, so nothing was grounded in it. Add documents on the Knowledge base page to ground future runs. |
| `kb_nothing_relevant` | Nothing in your knowledge base matched section {n}. Its requirements come from the document alone. |
| `kb_check_skipped` | Knowledge base matches could not be double-checked, so citations are shown unverified. |
| `kb_lookups_exhausted` | The model kept searching your knowledge base and ran out of attempts on section {n}, so that section produced no items. |
| `vision_off` | Figure descriptions are off for this run, so {count} figure(s) will have no description. |
| `regroup_skipped` | Loose top-level items could not be grouped by topic, so they are left as they are. |
| `conflict_check_skipped` | The near-duplicate conflict check could not run, so conflicting values were not looked for. Review similar requirements yourself. |
| `scoring_chunk_failed` | Wording checks failed for {count} requirement(s), so they have no quality score. |
| `served_from_cache` | {count} step(s) reused a recent identical answer, so they used no tokens. *(info, collapsed)* |
| `usage_unreported` | The model server did not report token counts, so totals show `--`. If you use Open WebUI, ask an administrator to enable the Usage capability for this model. *(once, info; see (g) V3)* |

**Failure, stall and cancel states** (T7, T14):
- **Connection dropped.** When the SSE `error` fires and no heartbeat arrives for more than 30 s, the freshness stamp reads "connection lost — reconnecting". This replaces the toast-only signal.
- **Long model call.** When heartbeats arrive with `inFlight` populated, the stamp reads "waiting on the model · 4m 10s".
- **No progress.** With no ledger change for more than 10 min but heartbeats still arriving, the stamp reads "no progress for 10 min · the run stops automatically after 60 min". It states the real watchdog threshold read from config and does not hardcode it.
- **Watchdog cancel.** The failure card says "Stopped automatically: no progress for over 60 minutes." This is not the same as "Cancelled". It needs a `cancelReason` (see c).
- **Cancel button.** It shows "Stopping at the next safe point…" until the server confirms, instead of the optimistic flip.

### Mobile (390 px)

- **Ticker.** It wraps to two lines (`line-clamp-2`) instead of `truncate`, so section labels survive.
- **Meta line.** It wraps by pairs, each label and value kept together with `whitespace-nowrap` on the pair. Order is: elapsed, tokens, updated, then model and context. If a pair does not fit, it moves to the next line; it is not dropped.
- **Strip.** The summary line collapses to "Limits and adjustments · 2 notices". The limits move inside the disclosure.
- **SectionStepList.** The token count moves under the label as a `text-meta` second line. Rows keep their shape (§11.3.1).
- **Hit targets.** These are 24×24 or larger (§13), including the strip's disclosure trigger.

### Accessibility

- **One `role="status"` (`aria-live="polite"`) region**, visually hidden, **present and empty in the initial markup** (assistive tech only announces changes to a region that already exists; see (g) V6). It announces only:
  - phase or headline changes, throttled to at most 1 per 15 s and collapsing to the latest;
  - `warning` notices, as their copy;
  - terminal states.

  It never announces every ticker sentence, token tick or percentage.
- **`job_failed` and connection loss** use `role="alert"`.
- **`ProgressBar` gets `aria-label`** ("Run progress") and `aria-valuetext` ("38 percent of the run, estimated" or "No progress estimate for this step"), per §13.
- **SectionStepList** becomes a `<ol>` with `aria-current="step"` on the active row. It stays non-interactive.
- **The strip** is a disclosure button with `aria-expanded`/`aria-controls`. Notice rows are a list.
- **Reduced motion.** The global kill-switch already covers it (`index.css:535`). The pulse stays decoration on top of the text stamp (§8.1). The frozen Spinner on the active row is paired with `aria-busy` on the list.

---

## (c) Backend work

### 1. Capture per-call metadata at the redact-first proxy (orchestrator)

`orchestrator/src/modules/llm`:

- **Extend `LlmChatResult`** (`llm-client.interface.ts:41-46`) with an optional `meta`:
  - `usage` (`{promptTokens, completionTokens, reasoningTokens, totalTokens} | null`), mapped from OpenAI `usage`, from `completion_tokens_details.reasoning_tokens`, or from Ollama-native `prompt_eval_count`/`eval_count` when present;
  - `reportedModel` (`response.model`);
  - `attempts`, a list of `{reason: 'temperature' | 'unsupported_params' | 'schema_rejected', params?: string[]}` built from the existing ladder (`openwebui.client.ts:256-285`). Each rung pushes its reason before retrying. Usage is summed across attempts that returned a response;
  - `redaction: {applied: boolean, counts: {email, url, guid, host, partNumber}}`. `redactor.ts` gains counting via `replace(re, fn)`. Only counts leave the function.
- **`toResult`** keeps returning `content`/`toolCalls`/`finishReason` and adds `meta`. Callers that ignore it are unaffected.
- **Streaming:** request `stream_options: {include_usage: true}` behind a new config flag `LLM_STREAM_INCLUDE_USAGE` (default `true`). Read the final chunk's `usage` even when `choices` is empty. If the upstream rejects the option, use the existing unsupported-params rung to retry once without it, and record `usage: null`. A stream that is interrupted or cancelled can also end without the usage chunk (OpenAI docs), so an aborted call counts as `callsUnreported`, never as zero tokens. (The streaming path appears to be used by chat, not the pipeline. Ship it for parity.)
- **`vision()`** gets a sibling `visionWithMeta()`. Its current `string` return is used elsewhere, so it is not changed.
- **The `/llm/chat` controller** (`llm.controller.ts:54`) returns `meta` in the JSON body. This is an internal proxy contract, so it gets its own schema (see 4).
- **Not done here:** no persistence and no publishing in the orchestrator LLM module. It stays a stateless proxy.

### 2. Aggregate per job in ingestion (the ledger)

New module `ingestion/app/survey/run_ledger.py`:
- `RunLedger(job_id, publisher)` is thread-safe, since branch calls run concurrently (`llm_leveling.py:2357-2375`). It holds limits, usage totals, `byPhase`, `bySection`, `inFlight` and notice counts.
- **Instrumentation point:** `OrchestratorLlmClient._post_chat` (`orchestrator_llm_client.py:~955`), the single funnel for all chat calls. Each call site already knows its function name, which maps to a `CallKind`.
  - Wrap each call in `ledger.call(kind, branch_index)`, a context manager.
  - On entry it adds to `inFlight`. On exit it reads `body.meta`, records attempts, including ingestion's own 429/5xx retries (`:959-971`), and emits `server_retry`.
  - It records `finishReason == 'length'` and emits `output_limit_reached`, alongside the existing `OUTPUT_TRUNCATED` warning.
  - Cache hits (the six "cache hit" sites) call `ledger.cached(kind)`.
- **Limits** are set once in `main.py:/level`, right after `_resolve_caps` (`main.py:1466-1468`). This needs `_resolve_caps` to return its **source**. A small additive change: a `source` field on `_ModelCaps`, or a sibling function. The silent `except` at `model_caps.py:208` sets `assumed_default` and emits `context_assumed`.
- **Notice emission sites** for the log-only paths (T6):
  - `root_regrouping.py:102` → `regroup_skipped`
  - `conflict_detection.py:128` → `conflict_check_skipped`
  - `conflict_detection.py:193` → aggregated into the same kind, with a count
  - `llm_leveling.py:648` → `kb_check_skipped`
  - agentic exhaustion (`orchestrator_llm_client.py:2464-2470`) → `kb_lookups_exhausted`
  - empty tool results → per-section counters, then `kb_nothing_relevant`
  - KB document count == 0 at retrieval setup → `kb_empty`
  - vision state (`main.py:1285-1320` logic, evaluated at the start of `/level` rather than only at the end) → `vision_off`
- **Embeddings** are counted as calls (`embed`) with usage when reported, so the conflict check and dedup are not invisible.
- **The parse stage (`/ingest`)** creates the ledger and stores its state in Redis (`job-ledger:{jobId}`, TTL matching the narration log). `/level` loads and continues it, so a job has one ledger across both requests.
- **The orchestrator's dedup and write phases** (`pipeline.worker.ts:913`, `JobsService.confirm`) add their counts by publishing an orchestrator-side ledger delta on the same channel. The schema allows a `source: 'orchestrator'` delta that the client merges. *(Alternative: the orchestrator reads `job-ledger:{jobId}`, updates it and republishes. Decide in implementation.)*

### 3. Publishing, throttling and persistence

- **Channel.** Reuse `job-events:{jobId}`, under a new SSE event name `ledger` and `notice`. Use SSE `event:` names, not a `type` sniff, so old clients ignore them safely.
- **Throttle.** At most one ledger snapshot per 2 s per job, and always on:
  - phase change;
  - first notice of a kind;
  - final.

  Notices are deduped by `(kind, branchIndex)`. Repeats only bump a count in the next snapshot.
- **Latest-wins replay.** Store the latest snapshot in `job-events:{jobId}:ledger` (SET, same TTL). The SSE replay (`job-events.controller.ts` replay block) sends it after `:current`. Because snapshots are cumulative and carry `seq`, the 50-entry narration cap and the `phase|message` dedupe (T13) do not apply.
- **Persistence.**
  - `JobEventPersistenceService` persists `notice` messages (severity `warning`/`info`, which also fixes T15). It persists **only** ledger snapshots with `final: true` or a phase change, about 10–20 rows per job.
  - No migration is needed. `JobEvent.detail` is generic JSON (`schema.prisma:269-280`).
- **Post-run fast path (optional, phase 4).** A `Job.runSummary Json?` column, plus `Job.completedAt`. The latter also unblocks the honest "run duration" that `NarrationTicker.tsx` currently omits. This is a migration, so it is listed separately for approval.
- **Heartbeat** (T7). The SSE controller writes an SSE comment `: keepalive\n\n` every 15 s, and an `event: heartbeat` with `{inFlight}` taken from `:ledger` every 30 s. **Heartbeats are not published to Redis and not persisted.** The stale-job watchdog therefore keeps measuring real progress (JobEvent rows), not connection liveness.
- **Volume estimate** *(unverified, to measure)*: a 500-page document with about 40 sections and about 200 calls produces about 200 call completions. Throttled, that is at most about 1 snapshot per 2 s. Payload is about 2–4 KB (dominated by `bySection`). This is well under the current narration volume, which includes `sectionNodes` text.

### 4. Contracts (shared/schemas is the source of truth)

New schemas:
- `shared/schemas/job-run-ledger.schema.json`, covering `RunLedgerSnapshot`, `RunNotice`, and the `CallKind`, `NoticeKind` and `CallPhase` enums.
- `shared/schemas/llm-call-meta.schema.json`, for the orchestrator→ingestion `meta` on `/llm/chat`.

Then:
- **TS:** `pnpm generate` in `shared/ts`. The orchestrator and frontend import the generated types. They are not hand-copied.
- **Python:** `shared/` has no Python generator today (review §6). Option A is to add `datamodel-code-generator` as a shared/ script. Option B is to keep a hand-written pydantic model plus a test that validates it against the schema. **Open question Q4.**
- **Frontend guard:**
  - Validate `ledger`/`notice` against the generated types.
  - On an **unknown `NoticeKind`**, render a generic row ("Something about this run was adjusted ({kind}). It will be listed in the review.") instead of dropping it.
  - Apply the same fallback rule to unknown narration phases (T10): show the backend `message` and keep the stepper where it is, instead of `console.error` and drop.
- **Existing narration** is not migrated in this work. That is a separate cleanup, also listed for approval. New events are schema-first from day one.

### 5. Redaction and data guarantees

- **Ledger and notice payloads carry only:**
  - enums;
  - numbers;
  - booleans;
  - the model name;
  - `branchIndex`;
  - `sectionLabel`, which is already emitted today as a heading label.
- **They never carry** prompts, responses, KB snippets, query strings, document text or upstream error bodies. Upstream errors become `{status, category}` only.
- **A CI test** asserts the schema has no free-text string fields except `sectionLabel` and `model`, and that `facts` values are number, boolean or enum.
- **Redaction counts** are counts per category only. Show "on · 14 items masked" (Q3), never the masked values.
- **`LLM_TRUSTED_LOCAL`** surfaces as "redaction off: local model". The user learns the truth instead of assuming protection.
- **Auth** is unchanged. New SSE events ride the existing owner-scoped stream (`job-events.controller.ts:63,80`). The `:ledger` key is read only by that controller.

---

## (d) Post-completion view: run summary

The run summary appears on `diff_ready`, `succeeded`, `failed` and `cancelled`, as a collapsed disclosure (closed by default, like §11.3.2's disclosures) titled "How this run went". It is placed after the stat tiles and before CollapsibleWarnings. It also goes into the existing "Download summary".

```
How this run went                                                           ▾
 47 min · qwen2.5:32b · context 32k (assumed) · 412,880 tokens (in 351,204 · out 61,676)
 knowledge base used in 7 of 9 sections · figures described: 23 · redaction on (14 masked)

 Step                       Calls   Tokens in   Tokens out   Time     Notices
 Describing figures            23      41,002        6,900    6m 10s      –
 Planning work items            9      88,110       12,034   11m 02s      1
 Checking knowledge base       14      31,775        1,210    2m 40s      –
 Writing requirement text       9     121,450       33,880   18m 15s      1
 Checking wording               6      61,300        7,200    6m 30s      –
 Conflicts and links            4       7,567          452    1m 20s      1
 Checking for duplicates       96          --           --    1m 03s      –
 (cached: 3 steps, 0 tokens)

 Limits and adjustments (3)                          → same rows as during the run
```

- **Per-section breakdown.** It is not a new table. SectionStepList keeps its token column after completion, in a read-only state.
- **Failed runs** show the summary up to the failure point, with the failing step marked, using existing `job_failed` data.
- **Unreported usage** shows `--` in cells, plus the `usage_unreported` notice. Totals are never computed from partial data without saying so: "at least 182,000 (2 of 9 calls unreported)".

---

## (e) Phased plan

| Phase | Content | Packages | Effort | Fixes |
|---|---|---|---|---|
| **0. Quick honesty and access fixes** (no contract change) | Live region + `ProgressBar` naming; single "of the run (est.)" label; banner sub-line no longer duplicates the ticker (static why-copy per phase from a frontend map); SSE `: keepalive` comment plus an `X-Accel-Buffering: no` response header (see (g) V5); mobile two-line ticker; "Stopping at the next safe point…" cancel state | frontend, orchestrator (controller only) | S | T4, T7 (partial), T8, T9, T14 (partial) |
| **1. Usage and attempt capture** | `LlmChatResult.meta`, redaction counts, stream `include_usage` flag, `/llm/chat` returns meta; `llm-call-meta.schema.json` | shared, orchestrator | M | T1 (capture), T2, T12 |
| **2. Ledger and notices** | `run_ledger.py`; call-kind instrumentation in `_post_chat`; caps source; notice sites for the log-only paths; Redis `:ledger`; throttle; persistence filter + `warning` severity; `job-run-ledger.schema.json` + generation; heartbeat event with `inFlight` | shared, ingestion, orchestrator | L | T1, T3, T5, T6, T11, T15, T16 |
| **3. Running-screen UI** | Meta line tokens/context; "Limits and adjustments" strip; SectionStepList tokens, notices and attempts; ticker from `inFlight`; freshness states (connection lost / waiting / no progress); unknown-kind fallbacks | frontend | M | T3, T7, T10 (client) |
| **4. Run summary** (+ optional migration) | Summary disclosure; Download-summary section; optional `Job.runSummary` / `completedAt` / `cancelReason` columns (needs approval) | frontend, orchestrator (+ prisma) | M | T14 |

Each phase ships on its own, and older clients ignore the new SSE event names.

### Test strategy

- **Orchestrator (vitest).**
  - `toResult` maps usage for OpenAI-shaped, Ollama-native-shaped and usage-absent responses.
  - Each retry rung records its attempt reason and sums usage.
  - A streaming final chunk with `choices: []` yields usage.
  - Redactor counts match.
  - SSE controller: the keepalive interval is cleared on close, and the ledger is replayed after `:current`.
  - Persistence filter: notices are persisted, intermediate snapshots are not.
- **Ingestion (pytest).**
  - `RunLedger` is concurrency-safe under the branch `ThreadPoolExecutor`.
  - The throttle emits at most one snapshot per window but always on a phase change.
  - Each notice site fires once per `(kind, branch)`.
  - The cache-hit path records 0 tokens.
  - `_resolve_caps` reports its source, including `assumed_default` on exception.
  - Contract test: every emitted payload validates against `job-run-ledger.schema.json`.
  - "No free text" test.
  - The existing `events.phase-sync.test.ts` gets a sibling test for `NoticeKind` copy coverage: every enum value has `KIND_META`-style copy.
- **Frontend (vitest + RTL).**
  - The latest-`seq` snapshot wins, out of order.
  - Unknown kind renders the generic row.
  - `--` renders for null usage.
  - The live region announces a phase change and a warning notice, and does not announce token ticks.
  - The strip auto-opens once.
- **Golden E2E.** Extend the existing fixtures (`docs/golden-e2e-survey-fixture.txt`) with a mock LLM that returns usage, one `finish_reason: "length"` and one 503. Assert the final persisted ledger totals and notices.
- **Playwright** (against a mocked SSE fixture; no real model needed):
  - At **390×844** and **1440×900**, for the states running/long-call, notice-arrives, connection-lost, failed and diff_ready-summary, check:
    - no horizontal scroll;
    - meta pairs never split;
    - strip trigger ≥ 24 px;
    - focus is visible on the disclosure;
    - with `prefers-reduced-motion: reduce` emulated, no animation and the text stamp still updates;
    - an axe scan shows no new violations.
  - Screenshots go in the PR.
- **Real-stack check** (cannot be done from this review): run one job against the deployed backend and confirm which `usage` fields arrive, streaming and non-streaming.

---

## (f) Risks and open questions

### Risks

- **The backend may not report usage.** Some Open WebUI or Ollama paths omit it. Mitigation: `--` plus the `usage_unreported` notice. The ledger never invents numbers. If usage is mostly absent, the token feature degrades to a call count. That is still useful, but less so.
- **Heartbeats vs the watchdog.** If heartbeats were persisted, they would hide dead jobs. The design keeps them out of Redis pub/sub and out of `JobEvent`. Keep it that way.
- **Counting retries twice.** Ingestion's 3× retry wraps the orchestrator's ladder. Each layer must record only its own attempts. Usage comes only from responses that returned.
- **Concurrency.** Branch threads update the ledger concurrently. It needs a lock, and snapshot serialisation must happen under the lock.
- **Cross-request ledger state.** `/ingest` to `/level` in Redis adds a dependency. If Redis is down, ledger publishing degrades best-effort, like narration today. It must never fail a job.
- **Scope creep toward a log.** The strip must stay an index of kinds. Reviewers should reject any per-call row list (§11.3).

### Open questions for the user

1. **Estimated tokens.** When the server does not report usage, should the UI show nothing (`--`, the current proposal) or a clearly labelled estimate from `_estimate_tokens` ("≈ 180k est.")? §12 allows a labelled estimate. Mixing it with real counts risks confusion.
2. **Cost.** Should tokens ever be converted to cost? This proposal says no: no pricing data exists and on-prem models have no per-token price.
3. **Redaction counts.** Is "14 items masked" acceptable to show? It reveals that sensitive-looking strings existed, but not what they were.
4. **Python types from shared schemas.** Add a generator (option A), or keep a hand-written model plus a schema-conformance test (option B)?
5. **Migration in phase 4.** Is the migration (`runSummary`, `completedAt`, `cancelReason`) acceptable, or should the summary be derived from the final persisted ledger event only?
6. **Strip auto-open.** Should the strip auto-open on the first warning notice, or always start collapsed?
7. **`sectionNodes[].text` in live narration.** It is already on the event bus and persisted. Should the existing `section_complete` payload be slimmed as part of this work (out of scope today)?
8. **BASELINE mode.** BASELINE makes no LLM calls by default. Should it show a minimal ledger ("no model used") for consistency, or nothing?

### Future extensions (explicitly out of scope)

Run controls (pause or skip a section, raise the output limit and retry a truncated section), model-asks-user clarifications and steering all build naturally on the same ledger. `inFlight` identifies the call to act on, and notices identify the remedy. They need write endpoints, auth on actions and a pipeline that can resume, so they are a separate decision.

---

## (g) Verification against external sources

Checked on 2026-10-05 against official documentation and established practice. Verdict per claim: **confirmed**, **amended** (this document was changed), or **open** (cannot be settled from documentation).

| # | Claim in this design | Verdict | Evidence | Effect on the design |
|---|---|---|---|---|
| V1 | With `stream_options.include_usage`, usage arrives on one extra final chunk with an empty `choices` array; `completion_tokens_details.reasoning_tokens` and `prompt_tokens_details.cached_tokens` exist; `finish_reason: "length"` means the token limit was hit. | **Confirmed.** Also: an interrupted or cancelled stream may never deliver the usage chunk. | [OpenAI: chat completion streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) | Added the interrupted-stream rule to (c)1: aborted calls are `callsUnreported`, not zero. Consider also keeping `cachedInputTokens` from `prompt_tokens_details.cached_tokens` in the ledger (not the same thing as `cachedCalls`, which counts reuse inside ingestion). |
| V2 | Ollama-native fields `prompt_eval_count`, `eval_count`, `done_reason` carry usage; Ollama's OpenAI-compatible endpoint supports `stream_options.include_usage`. | **Confirmed.** The native fields appear **only on the final chunk**. The docs do **not** describe any way to detect that a prompt was truncated to `num_ctx`. | [Ollama API reference](https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) | The `limits.contextWindowTokens` value is what we **configured or resolved**, not something observed. The UI must not claim "nothing was cut off". Silent prompt truncation by the backend stays undetectable from the API, so it is listed under limitations, not promised as a notice. A heuristic (reported prompt tokens close to `num_ctx`) is possible but unverified, so it is not in scope. |
| V3 | Usage may be missing from the deployed backend. | **Confirmed, and the cause is concrete.** Open WebUI adds `include_usage` itself **only when the model has the "Usage" capability enabled**; without it the provider is not asked for usage in a stream, and non-streaming requests are left as the provider sends them. LiteLLM can also be configured to always include stream usage (`always_include_stream_usage`). | [Open WebUI API endpoints](https://docs.openwebui.com/reference/api-endpoints/), [LiteLLM streaming](https://docs.litellm.ai/stream) | **Amended:** the `usage_unreported` copy now gives cause and remedy (§12). The remedy is a deployment setting, so the real-stack check in (c) must record which backend and which capability setting was used. |
| V4 | Show `--` for unreported usage rather than an estimate (open question 1). | **Open, with precedent on both sides.** Langfuse prefers provider-reported usage and falls back to tokenizer estimates when none is reported, but states that estimation is **not supported for reasoning models**. | [Langfuse token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) | Recommendation: keep `--` as the default. If an estimate is ever added, label it "≈ … est.", never add it to reported totals, and never show one for reasoning models. |
| V5 | New SSE events can use new `event:` names that old clients ignore; a periodic comment keeps the stream alive; nginx must not buffer. | **Confirmed.** `EventSource` only dispatches named events to listeners registered for them, and `frontend/src/api/events.ts` registers `stage` and `narration` only. Comment lines are the documented keep-alive. `frontend/nginx.conf.template` already sets `proxy_buffering off` and `proxy_read_timeout 3600s` for `/api/`. Two caveats: the controller itself sets no `X-Accel-Buffering: no`, so another proxy or ingress in front of it could still buffer; and over HTTP/1.1 browsers allow only 6 SSE connections per browser and domain. | [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events); `orchestrator/src/modules/pipeline/job-events.controller.ts:84-87`; `frontend/nginx.conf.template:33-44` | **Amended:** Phase 0 adds the `X-Accel-Buffering: no` header. The design adds no new connection (it reuses the job stream), but the multi-tab limit applies, so confirm HTTP/2 at the ingress. Optionally set `id: <seq>` on `ledger` events so reconnects send `Last-Event-ID`; not needed for correctness because snapshots are latest-wins. |
| V6 | One polite status region, throttled; `role="alert"` for failure; progress bar gets a name and value text. | **Confirmed, one addition.** Assistive tech announces only dynamic changes, so the region must exist in the initial markup and start empty; `role="status"` and `role="log"` should carry a redundant `aria-live="polite"`; combining `role="alert"` with `aria-live` double-speaks in VoiceOver on iOS (the design uses `role="alert"` alone). | [MDN: ARIA live regions](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions) | **Amended:** the accessibility bullet now requires the region in the initial markup. Add `aria-atomic="true"` on the announcer so a warning is read as a whole sentence. |
| V7 | Percentage plus "step N of M" text, an honest estimate label, and a visible "no progress" state for long runs. | **Confirmed.** Percent-done indicators are recommended beyond about 10 seconds; explanatory text such as "3 of 50" is advised; a bar that races ahead then stalls erodes trust, so estimates should be labelled as such. | [NN/g: Progress indicators](https://www.nngroup.com/articles/progress-indicators/) | No change. The "(est.)" label and "no progress for N min" state are the right mitigations. |
| V8 | Record only enums, numbers, model name and section label; never prompt or response text (c)5. | **Confirmed as industry convention.** OpenTelemetry's GenAI conventions treat `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` and `gen_ai.tool.definitions` as **opt-in** because they may contain user data. | [OpenTelemetry GenAI semantic conventions: spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) | No change. |
| V9 | Ledger field names (`promptTokens`, `completionTokens`, `reasoningTokens`). | **Amended for alignment.** OpenTelemetry GenAI names are `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.request.max_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.response.model`. All are marked **Development** stability, so they may still change. | same OTel page | The repo already has OpenTelemetry in both services: `ingestion/app/otel.py` and `orchestrator/src/tracing.ts`. Ingestion's LLM spans set `gen_ai.request.model` and `gen_ai.operation.name` but **no usage attributes** (`orchestrator_llm_client.py:1227-1228` and similar). **Recommendation, to be done in phase 2:** record each call once in `RunLedger.call(...)` and write the same values to the span as the OTel attributes above, so one capture feeds both the UI ledger and traces. Name the ledger fields `inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens` and keep the OTel mapping in one function so a convention change touches one place. Also note the existing spans put custom attributes in the `gen_ai.*` namespace (`gen_ai.response.node_count`, `gen_ai.request.item_count`); moving those to a `req2ado.*` namespace is the usual OTel practice but was not confirmed in the fetched text, so treat it as a suggestion. |
| V10 | The design answers "what is it doing, why, how well, within what limits". | **Consistent with** Microsoft's guidelines for human-AI interaction: G1 make clear what the system can do, G2 make clear how well it can do it (including low-performance alerts), G11 make clear why it did what it did. | [G1](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-what-the-system-can-do/), [G2](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-how-well-the-system-can-do-what-it-can-do/), [G11](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/) | The "why" sentence per call kind is the G11 pattern ("local explanation"); the notices and quality flags are the G2 pattern. No change. |

### What this verification could not settle

- Which usage fields **your deployed backend** returns for non-streaming and streaming calls, including reasoning tokens, and whether the Usage capability is enabled on the production models. Open WebUI's documentation says non-streaming requests are passed through as the provider sends them, so confirm with one real job (see the real-stack check in (e)).
- Whether any proxy or ingress in front of the orchestrator buffers SSE other than the nginx config in this repo.
- OpenTelemetry's GenAI conventions are in Development status, so attribute names may change.
- No best-practice source was found for a "limits and adjustments" index specifically; the strip follows the repo's own CollapsibleWarnings precedent (DESIGN.md §11.3.3) and the HAX guidelines above.

---

## DESIGN.md amendments this needs (§17 protocol)

1. **§11.3 structure diagram.** Add the "Limits and adjustments" row inside ProgressBanner, between the meta line and SectionStepList. Record that it is *not* the superseded activity log: it is an index of notice kinds with counts, with no per-event rows.
2. **§11.3 meta line.** Change from `elapsed · model · updated` to `elapsed · model · context · tokens · updated`, with the pair-wrapping rule for narrow widths and `--` for unreported tokens.
3. **§11.3 banner sub-line.** Redefine it as the "why" sentence, not the latest message, to end the duplication with the ticker.
4. **§11.3 percentage label.** It reads "of the run (est.)". Remove "of this section".
5. **§11.3.1 SectionStepList.** Add a token column, a notice marker and an attempt suffix on the active row. The rows stay non-interactive.
6. **§11.3 ticker.** Allow `line-clamp-2` at narrow widths. Today the ticker is a one-line truncate.
7. **§11.3.2.** Add a fourth disclosure, "How this run went", with the same mechanics.
8. **§13.** Specify the running-screen live-region contract: polite, throttled, phase and warning only, `alert` for failure and connection loss.
9. **§12.** Add the call-kind and notice-kind copy tables, or point to their single home in `utils/warningKinds.ts` / a sibling `utils/callKinds.ts`.
10. **§8.** No new keyframes. The new strip row uses Entrance, so no motion-table change is needed.
