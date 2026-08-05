# Known issues -- live UI review (2026-08-04)

Found during a live stack rebuild + Playwright-monitored session against a real SURVEY job
(`AirPro_BP_ICD_Revision_0.3.docx`, job id `84463ac3-6772-4cb5-8dbf-502d9f7b9b11`). None fixed
yet -- logged here so they aren't lost.

## 1. Contradictory "Cancelled" panel shown on a RUNNING job

**Status:** FIXED and verified (359 frontend tests pass, including a new dedicated regression
test). Rebuilt/redeployed.

While a job is genuinely `running` (stepper actively on Analyze, elapsed ticking, SSE connection
live), the page ALSO renders an EmptyState card reading "Cancelled before a diff was produced" /
"This run was cancelled before parsing/analysis finished, so there is nothing to review."

**Cause:** `frontend/src/pages/jobDetailLayout.ts:30-35`, `shouldShowTabs()`:

```ts
export function shouldShowTabs(status: string | null, diffLength: number, auditLength: number): boolean {
  if (status && STATUSES_WITH_A_COMPUTED_DIFF.has(status)) return true;
  return diffLength > 0 || auditLength > 0;
}
```

`running`/`pending` aren't in `STATUSES_WITH_A_COMPUTED_DIFF`, and early in a run `diff`/`audit`
are both empty -- so this returns `false` for a running job too, not just cancelled/failed.
`JobDetail.tsx:840-843` then falls into the EmptyState branch and picks copy via
`status === 'failed' ? 'No diff was produced' : 'Cancelled before a diff was produced'` -- since
`running` isn't `'failed'`, it defaults to the **cancelled** message. The comment directly above
that block (`JobDetail.tsx:830-834`) explicitly (and wrongly) assumes this branch is "only
reachable by cancelled (before diff_ready) and failed."

**Implemented fix:** guarded with the already-imported `isRunDetailStatus(status)` so nothing
renders in that slot while a job is actually running/pending (the stepper/banner above already
covers that state):

```jsx
{showTabs ? (
  <Tabs>...</Tabs>
) : isRunDetailStatus(status) ? null : (
  <Card><EmptyState .../></Card>
)}
```
Applied at the `showTabs` ternary in `JobDetail.tsx`. New test:
`'does not render the "Cancelled before a diff was produced" panel while a job is actually running'`
in `JobDetail.test.tsx`, asserting a `running` job with no diff yet never shows either the
cancelled or failed EmptyState copy.

## 2. Job-status UI gives too little signal during long-running phases ("stays in the dark")

**Status:** confirmed via live evidence, root cause is item 3 below (same underlying gap).

Observed 20+ minutes of a real running job showing the exact same banner text
("Preparing analysis -- splitting sections, retrieving context"), same model badge, and an
indeterminate progress bar, with zero further detail. Note: the indeterminate bar / "no fixed
step count to measure against" copy (`ProgressBanner.tsx:108-121`) is an intentional design
choice (explicit "do not guess, calculate" comment there) -- NOT itself a bug. The real gap is
that no narration event at all was published for the entire 20+ minute window (see item 3) --
an honest indeterminate UI over a genuinely silent backend, rather than an honest indeterminate
UI over a backend that's actually reporting incremental progress.

## 3. Backend goes silent for 20+ minutes during deterministic-subtree detection -- no narration wired

**Status:** FIXED (subtree-level kickoff event) then found to be INSUFFICIENT by live testing --
see item 6, which adds per-chunk granularity inside each subtree. This is the mechanism behind
item 2, and explains the originally-reported "scoring phase goes back to analyze phase"
observation (that turned out to be a stale/frozen UI, not a real backend phase regression -- see
Notes below).

Live evidence for job `84463ac3-6772-4cb5-8dbf-502d9f7b9b11`:
- Redis `job-events:<id>:narration-log` (all 50 entries dumped) -- last phase ever published is
  `preparing_analysis`, fired once at function entry.
- Ingestion container logs for the same job id show real work continuing well past that point:
  two separate `POST http://orchestrator:3001/llm/chat` calls (11:39:35, 11:47:15) and a batch of
  `app.leveling.root_regrouping` WARNING log lines at 11:52:22 (job started 11:32:28 -- ~20 min in).
- No `"Failed to publish narration"` warning anywhere in the logs -- `NarrationPublisher.publish()`
  (`narration_publisher.py:251-300`) isn't throwing; it's just never being called during this
  window.

**Root cause:** `_detect_deterministic_subtrees` (`ingestion/app/leveling/llm_leveling.py:917`)
has **no `progress_callback` parameter** in its signature at all (`doc, customer_id,
title_tag_client, synthesis_client, parent_summary_client, model`). It runs immediately after the
one `preparing_analysis` fire, and for a document with many deterministic ID-hierarchy
table/heading rows (this AirPro doc: hundreds of `det0_*` nodes across many subtrees) it makes a
real, unbounded number of sequential LLM calls:
- `id_tree_builder.py:120` -- `title_tag_client.title_and_tags_for_rows(...)`
- `id_tree_builder.py:410` -- `synthesis_client.synthesize_leaf_requirements(...)`
- plus, per subtree, `_repair_requirement_hierarchy` (`root_regrouping.py:212`) -- also has no
  `progress_callback` parameter (`nodes, node_id_prefix, warnings` only).

None of these three functions ever receive or invoke `progress_callback`. The `det0_*`
re-parenting warnings observed in the logs come from `_repair_requirement_hierarchy`, called from
inside `_detect_deterministic_subtrees` (`llm_leveling.py:981` and `:998`) -- real, completed work
with structurally zero narration capability.

For a document that's heavily/fully deterministic (matches this run: every regroup warning
referenced `det0_*` ids, never `br0_*`, meaning the LLM branch-analysis path -- where
`analyze_section`/`section_complete` narration lives -- never even executed), this silent window
is effectively the entire multi-minute middle of the job.

**Proposed fix:** thread `progress_callback` through `_detect_deterministic_subtrees` ->
`build_hierarchy_subtree` -> the per-subtree/per-chunk title-tag and synthesis calls, firing a new
lightweight phase (e.g. `deterministic_subtree`, with a running subtree-index counter) the same
way `describe_figure` already reports incremental progress during parsing. Also thread it into
`_repair_requirement_hierarchy`'s call sites if a per-subtree "repairing hierarchy" signal is
wanted, though the subtree-level event above may already be enough granularity.

**Notes on the original "scoring goes back to analyze" report:** code-level check of
`llm_leveling.py`'s per-branch loop confirms scoring was deliberately moved OUT of the per-branch
loop to run once, after all branches (comment at ~line 1678) -- the backend's real phase order is
monotonic, there is no genuine re-entry into analyze after scoring. What was actually observed
live matches item 3 above: the UI stayed frozen showing an early phase while the backend had
already moved far past it silently -- easy to misread as "went backward" when it's really "never
moved forward on screen at all."

**Live confirmation (same job, later):** watched the job reach `Score` directly -- stepper jumped
Parse✓ → Analyze✓ → Score(active) at **33:32** elapsed, with zero narration in between (matches
the silent `_detect_deterministic_subtrees` window predicted above almost exactly). Once Score
started, real narration resumed immediately and stayed live: "Scoring requirement quality --
scoring 150 drafted requirement(s) (model: qwen3.6:35b), grounded with 1 KB file(s) (strong: 0,
weak: 1)", `545 / 545 blocks`, `150 drafted`, a "Finishing up..." status chip, ticking every few
seconds. Analyze itself never showed as active again after Score started -- no backward jump,
confirming the phase order is genuinely monotonic and the original report was the frozen-UI
illusion, not a real regression. Also confirmed: item 1's contradictory "Cancelled before a diff
was produced" panel is still rendered underneath, unchanged, now during Score -- proves that bug
is not tied to any specific phase, it persists through the entire pre-`diff_ready` window
regardless of which step is actually running.

## 4. "Finishing up..." chip is a lie -- shown for the entire tail, not near completion

**Status:** root-caused, fix not applied. Found while watching item 3's live confirmation.

The moment the job entered `Score`, the status chip switched to "Finishing up..." -- but `Score`
is followed by epic/feature scoring, conflict detection, root regrouping, and trace-link
inference, each potentially its own multi-minute LLM pass. "Finishing up" implies near-completion;
in reality it can be shown for the majority of the job's remaining runtime.

**Cause:** `ProgressBanner.tsx:154-157`:

```ts
} else if (mode === 'survey' && isTailPhase) {
  etaText = 'Finishing up…';
}
```

`isTailPhase` (`ProgressBanner.tsx:110-116`) is `true` for `score_requirements`,
`score_requirements_done`, `detect_conflicts`, `regroup_roots`, AND `infer_trace_links` --
five distinct phases, each shown the identical "Finishing up..." label the instant any one of
them starts, with no distinction between "just started scoring" and "about to return." The
comment above it (`ProgressBanner.tsx:105-109`) correctly explains WHY no real ETA is
calculable for these phases (no `blocksTotal` denominator once every section is done) -- but the
fallback copy overstates confidence it doesn't have. Honest-but-vague ("Finishing up...") would
be one thing; the actual failure mode is that it reads as "any second now" regardless of whether
1 or 5 more tail phases remain.

**Proposed fix:** replace the blanket "Finishing up…" with per-phase wording (e.g. "Scoring
quality...", "Checking for conflicts...", "Grouping by topic...", "Resolving trace links...")
using the same `latest.phase` the rest of the banner already reads, reserving "Finishing up…" (if
kept at all) for only the LAST tail phase (`infer_trace_links`) rather than all five.

## 5. Confirmation dialog animation snaps position at the end (Tailwind v4 `translate`/`transform` split)

**Status:** FIXED and verified live. User also asked for the dialog to open/close from/to the
triggering button specifically -- implemented together with the snap fix, since the same
keyframe rewrite is the natural place for both.

User-reported symptom: clicking a button to open a confirmation dialog (e.g. "Confirm" on the
Diff Ready page) is not smooth -- about 3 janky frames right at the start/end -- and the dialog
appears to open from the page's top-left-ish area instead of growing from the button that was
clicked.

**Measured (instrumented via `requestAnimationFrame` sampling of the dialog's
`getBoundingClientRect()`/`getComputedStyle()` through the whole open transition):**

| t (ms) | x | y | opacity | transform |
|---|---|---|---|---|
| 16 | 367 | 265 | 0 | `matrix(0.97,0,0,0.97,-220,-119.5)` |
| 107 | 361 | 262 | 0.824 | `matrix(0.9947,0,0,0.9947,-220,-119.5)` |
| 208 | 360 | 261 | 0.9995 | `matrix(0.99999,0,0,0.99999,-220,-119.5)` |
| **225** | **580** | **381** | **1** | **`none`** |
| 240+ | 580 | 381 | 1 | `none` (steady state) |

Position snaps by **+220px x / +120px y** in the single frame where the animation ends and
`transform` flips from the keyframe's matrix to the literal string `none`. That snap is the
"not smooth" jank the user saw, and the dialog's resting position (580, 381 -- its raw
`left:50%; top:50%` anchor, uncentered) vs its correctly-centered animated position (360, 261)
is why it visually reads as opening from/settling into the wrong corner rather than growing
smoothly from center (or from the trigger).

**Root cause:** Tailwind v4 (`frontend/package.json`: `"tailwindcss": "^4.3.3"`) compiles
`-translate-x-1/2 -translate-y-1/2` (used on `RadixDialog.Content`, `Dialog.tsx:38`) to the
native CSS **`translate`** property, not the legacy `transform: translate(...)`. But the
hand-written keyframes in `frontend/src/index.css:253-263` (`dialogIn`) and `:277-287`
(`dialogOut`) use the OLD combined syntax:

```css
@keyframes dialogIn {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.97); }
  to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
```

During the animation, this keyframe's own `transform` fully drives (correct) centering. The
moment the animation finishes, that animated `transform` contribution goes away -- and since the
static utility classes never populate `transform` in Tailwind v4 (they populate the separate
`translate` property instead), the element's resting `transform` computes to `none`, dropping
the centering it had throughout the animation and snapping to the raw `left:50%; top:50%`
anchor point instead.

**Proposed fix:** stop touching `transform`/`translate` in the keyframes at all -- animate only
the native `scale` property, letting the static utility classes' `translate: -50% -50%` stay in
effect uninterrupted for the entire transition:

```css
@keyframes dialogIn {
  from { opacity: 0; scale: 0.97; }
  to   { opacity: 1; scale: 1; }
}
@keyframes dialogOut {
  from { opacity: 1; scale: 1; }
  to   { opacity: 0; scale: 0.97; }
}
```
Same fix likely needed for the popover-style variants (`popIn`, mentioned in a comment at
`index.css:288-292`, already scale-only per that comment -- worth double-checking it doesn't
have the same `transform`-based mistake once this is fixed for dialogs).

Separately, the dialog is a centered modal by design (Radix `Dialog`, not a trigger-anchored
popover) -- fixing the snap alone would NOT make it originate from the button. User explicitly
asked for that too ("I need the dialog to open/close from/to the button"), so it was implemented
in the same change rather than left as a follow-up.

**Implemented fix (`frontend/src/ui/Dialog.tsx`, `frontend/src/index.css`):**

1. `index.css` `dialogIn`/`dialogOut` keyframes rewritten to animate only the native `scale`
   property (opacity + scale, nothing else) -- never touches `translate`/`transform`, so the
   static utility classes' centering is continuous through the whole transition with no
   end-of-animation discontinuity. Scale range widened from a subtle `0.97→1` to `0.05→1` so the
   "grows from a point" effect (below) is actually visible.
2. `Dialog.tsx` adds a module-level capture-phase `pointerdown` listener (`lastPointerDownCenter`)
   that records the center of whatever button/link/role="button" was last pressed, anywhere in
   the app. Zero changes needed at any of the many call sites -- every existing button's
   `onClick={() => setXOpen(true)}` pattern is untouched; this listener alone supplies the origin.
3. A `useLayoutEffect` keyed on `open` reads that last-pressed center once the dialog's content
   node is mounted (but before paint), computes the offset relative to the dialog's own
   (already-centered) box, and sets `--dialog-origin-x`/`--dialog-origin-y` as inline CSS custom
   properties on the content node.
4. The content element's class list adds `[transform-origin:var(--dialog-origin-x,50%)_var(--dialog-origin-y,50%)]`
   -- falls back to the box's own center (50% 50%) when there's no captured click (keyboard-
   triggered open, or the very first render before any pointerdown ever fired).

**Verified live** (same instrumentation as the original bug report, re-run after rebuild +
redeploy of the `frontend` service): 20 sampled frames across the full ~210ms open transition --
`scale` increases monotonically `0.05 → 1` with **zero jump**, `transformOrigin` stays fixed at
`220px 119.5px` (the real captured button-center offset) for the entire transition, box
dimensions grow smoothly from `22×12` to the full `440×239`, and the previous `transform: none`
snap at animation-end no longer occurs at all (`transform` stays `none` throughout now -- as
expected, since positioning is no longer part of the animated properties -- only `scale` changes,
confirmed `none → 1 → none` is the SAME steady-state value before and after, not a discontinuity).

## 6. deterministic_subtree narration still froze for 5+ min -- subtree-level granularity was too coarse

**Status:** FIXED and verified (864 ingestion tests pass, 3 new tests specifically proving
per-chunk firing). User caught this live on a fresh job (`a64f7b87-54e2-4826-b00c-1fd3d6df094d`,
`http://localhost:4082/jobs/a64f7b87-54e2-4826-b00c-1fd3d6df094d`): "Extracting a deterministic
hierarchy subtree (1 of 1 -- Heading hierarchy)" stuck for ~5 minutes with zero further update,
directly contradicting item 3's fix.

**Root cause:** item 3's fix (see above) only fired ONE `deterministic_subtree` event per
SUBTREE, right before `build_hierarchy_subtree` is called -- but that function's own
`title_tag_client`/`synthesis_client` calls are internally chunked (150 rows/chunk,
`_TITLE_TAG_CHUNK_SIZE`/`_SYNTHESIS_CHUNK_SIZE` in `id_tree_builder.py`) with **zero narration
between chunks**, and a single chunk's LLM call can itself take several minutes on a slow model
(confirmed live: ingestion logs showed exactly one `POST .../llm/chat` call spanning the whole
5-minute window, matching a single big batched call, not multiple sequential ones). "Subtree-level
granularity is probably enough for MVP" (this doc's own item-3 write-up) was wrong -- confirmed
wrong by this live catch.

**Implemented fix:** threaded `progress_callback`/`subtree_index`/`subtree_count`/`subtree_label`
through `build_hierarchy_subtree` -> `_apply_title_tag_pass`/`_apply_synthesis_pass`
(`ingestion/app/leveling/id_tree_builder.py`), firing one `deterministic_subtree` event **per
chunk**, not just once per subtree -- e.g. "Table t0 -- enhancing titles/tags for 47 node(s)
(chunk 1 of 1)" or, for a >150-row subtree, "...(chunk 1 of 2)" then "...(chunk 2 of 2)". Same
subtree-level kickoff event from item 3 is unchanged; this adds finer signal INSIDE it.

**New tests** (`ingestion/tests/test_id_tree_builder.py`):
`test_build_hierarchy_subtree_fires_progress_before_the_title_tag_chunk`,
`test_build_hierarchy_subtree_fires_progress_before_the_synthesis_chunk`, and
`test_build_hierarchy_subtree_fires_one_progress_event_per_chunk_not_per_subtree` (151 rows ->
2 chunks -> 2 distinct events, proving progress is per-call, not per-subtree).

## 7. `table_detected` reported "0 row(s)" for every real table

**Status:** FIXED and verified. Found while investigating item 6, from the SAME live job's
activity log: `Detected a table t0 -- 0 row(s) (not ID-shaped, will go through LLM analysis)`,
repeated for all 5 tables -- indistinguishable from a genuinely empty or mis-parsed table, which
directly undermines item 2/7's own goal ("did my tables ingest correctly").

**Root cause:** `ingestion/app/main.py`'s `table_detected` firing used
`len(rows_from_table(table))` as the reported row count -- but `rows_from_table` returns only the
rows that QUALIFY as a deterministic ID-hierarchy (legitimately `[]` for a table whose real
content just isn't ID-shaped, per its own docstring). A table can have 40+ real rows of plain
content and still correctly return `[]` here -- the count and the qualifying check were
conflated into one number.

**Implemented fix:** report `len(table.rows)` (the `Table` model's own raw parsed row count) as
`tableRowCount`, keeping `tableQualifies = bool(rows_from_table(table))` as a fully separate
field, never derived from the same value.

**New test:** extended `test_ingest_publishes_describe_figure_and_parse_done_narration_when_job_id_is_given`
(`ingestion/tests/test_ingest_endpoint.py`) to assert `tableRowCount` matches the real table's row
count from parsing the same fixture directly (not a hardcoded number), and is `> 0` -- would have
caught this regression immediately.

## 8. No defense against a job running forever after the host environment was suspended

**Status:** FIXED and verified (549 orchestrator tests, minus pre-existing infra-dependent
e2e specs unrelated to this change; 361 frontend tests). Live-caught: job
`1732b880-8cba-4437-97a5-35a55a19934c` showed `status='running'` for 15h15m because the host
Mac slept -- Docker Desktop's VM (Postgres, Redis, ingestion, orchestrator, all of it)
suspends with the host and resumes exactly where it left off on wake. The job's own
processing was genuinely fine once resumed, but nothing in the system ever caps how long a
job can sit with zero activity before something notices -- a truly hung/dead connection would
look identical to that 15-hour gap.

**Implemented fix:**
1. **`StaleJobWatchdogService`** (`orchestrator/src/modules/pipeline/stale-job-watchdog.service.ts`,
   new) -- a background singleton (same `OnModuleInit` lifecycle as `JobEventPersistenceService`),
   polling every 5 min (`STALE_JOB_CHECK_INTERVAL_MS`) for `pending`/`running` jobs whose most
   recent `JobEvent` (the durable narration trail from the observability MVP above) is older
   than 60 min (`STALE_JOB_THRESHOLD_MS`) -- falling back to the job's own `createdAt` if no
   event has landed yet. A stale job gets auto-cancelled via the ALREADY-EXISTING
   `JobsService.cancel()`, inheriting its own already-honest limitation (takes effect at the
   pipeline worker's next checkpoint, not mid-call, since there's no cross-process abort
   channel for an in-flight LLM HTTP call). Worst case for "runs forever" becomes
   threshold + interval (~65 min), not 15 hours.
2. `JobsService.cancel()` gained an optional `reason` param (default: the pre-existing
   `'Job cancelled by user'`) so the watchdog's automatic cancellation writes an accurate,
   distinguishing `AuditEntry` message instead of falsely claiming a user did it.
3. **LLM backend health check** -- new `GET /llm/status` (`llm-status.controller.ts`, new,
   session-authed -- deliberately a SEPARATE controller from the bearer-gated `LlmController`,
   sharing the `llm` path prefix safely since `@UseGuards` is per-controller-class) backed by
   `OpenWebUiClient.checkHealth()` (new method, `openwebui.client.ts`) -- a 5-second-timeout
   reachability probe, unlike every other call in that client which relies on the SDK's much
   longer default. Surfaced as a third sidebar status dot ("LLM Backend") in `AppShell.tsx`,
   same pattern as the existing Azure DevOps/SharePoint dots -- answers "is my LLM backend
   even alive right now" before a job silently sits for hours against an unreachable backend.

**New tests:** `stale-job-watchdog.service.spec.ts` (stale job cancelled with the right
message; fresh job untouched; no-JobEvent-yet job falls back to `createdAt`; one job's
`cancel()` failure never aborts the sweep for others), `llm-status.controller.spec.ts`,
`openwebui.client.spec.ts` (`checkHealth` reachable/unreachable cases, explicit 5s timeout
asserted), `jobs.service.spec.ts` (custom `reason` written correctly), and
`AppShell.test.tsx` (LLM Backend dot renders reachable/unreachable).

## 9. JobEventPersistenceService had a blind spot during its own restarts

**Status:** FIXED and verified (10 new/updated tests, full 489-test orchestrator suite green).

Root-caused while investigating why job `1732b880`'s real, live `job_failed` narration
(`"Job failed: [Errno 111] Connection refused (ConnectError) -- last known phase:
describe_figure, after 4046s"`, confirmed the user actually SAW it live) never made it into the
durable `JobEvent` table. Pub/sub delivery only reaches a subscriber connected AT THE MOMENT of
publish -- if `JobEventPersistenceService`'s own connection happened to be down (confirmed: the
`orchestrator` container was mid-restart for an unrelated deploy at almost exactly that moment),
the event is durably lost forever, even though the same payload also landed in Redis's own
bounded narration-log LIST and `:current` stage key (written directly by the publisher,
independent of whether anyone was subscribed).

**Implemented fix:** `JobEventPersistenceService` now takes a SECOND, plain (never-subscribed)
Redis connection alongside its existing psubscribe'd one -- a subscribed connection can't issue
any other command, same constraint `REDIS_SUBSCRIBER_FACTORY` already documents. On startup,
`backfillMissedEvents()` scans every `job-events:*:narration-log` and `job-events:*:current` key
directly via that connection and persists whatever isn't already represented in Postgres
(deduped by `(phase, message)` against up to 200 recent rows per job), closing exactly the window
its own downtime would otherwise blind it to. Runs once per process start, fail-open (wrapped,
logged, never crashes startup).

**New/updated tests** (`job-event-persistence.service.spec.ts`): narration-log entries missing
from Postgres get backfilled; an already-persisted entry is never re-inserted (the common case
for a job with no downtime overlap); the `:current` stage key backfills the same way; a repeated
identical message within one narration-log is only inserted once (not once per occurrence).

## 10. Vision captioning returned empty for 100% of figures -- thinking model burned max_tokens on reasoning

**Status:** FIXED and verified (493 orchestrator tests pass, including a new dedicated test).
User caught this on TWO separate fresh jobs (cache-poisoning fix from item 7 ruled out as the
cause) -- every single figure came back "no useful caption returned", ~5s each, no errors.

**Root cause:** `OpenWebUiClient.vision()` (`orchestrator/src/modules/llm/openwebui.client.ts`)
never disabled reasoning, unlike `chat()` in the SAME class, which already has an established
`opts?.think === false -> reasoning_effort: 'none'` knob for exactly this problem. The
configured vision model, `gemma4:e4b`, reports a real `"thinking"` capability (confirmed via
`ollama show --verbose`). Its chain-of-thought tokens consumed the entire `max_tokens: 200`
budget before ever producing a real answer token -- `message.content` came back genuinely
empty every time, while the actual reasoning text landed in the separate `message.reasoning`
field this method never reads. 100% reproducible for every figure in every document, not model
flakiness on select images.

**Implemented fix:** added `reasoning_effort: 'none'` to `vision()`'s request params,
unconditionally (no caller ever legitimately wants a reasoning trace for a one-line image
caption -- same "structured extraction, not creative writing" principle the existing
temperature=0 comment already states).

**New test:** `openwebui.client.spec.ts` -- asserts `reasoning_effort: 'none'` is always sent
on a `vision()` call.

## 11. KB retrieval treats standards/methodology docs the same as customer-content docs (BACKLOG, not yet implemented)

**Status:** IMPLEMENTED and deployed (876 ingestion, 563 orchestrator, 369 frontend tests pass). Surfaced live: user uploaded 3 KB files that are
CMMI + requirements-writing-standards documentation, intended as an always-on grounding
baseline for quality scoring and (eventually) trace-link analysis between items. Only 1 of
the 3 showed up in `score_requirements`'s "Grounded against" chip, at a weak 39% similarity.

**Root cause:** there is exactly one KB retrieval mechanism today
(`ingestion/app/kb/retrieval.py:retrieve_context`), and it is topical-similarity search:
embed the document's own content, pull the `top_k=5` most similar chunks across the WHOLE
KB collection, drop anything below a `max_distance=0.7` (similarity >= 0.3) floor, dedupe
best-hit-per-file. This is the right mechanism for "ground against similar past customer
documents" but the wrong one for standards/methodology text -- a CMMI/INCOSE doc's relevance
to a hardware backplane spec is not topical/semantic, so it legitimately scores low
similarity and gets starved out by whichever KB file happens to share more vocabulary with
the current document.

Separately, quality scoring already has a SECOND, independent grounding path --
`CriteriaRetriever` (`ingestion/app/quality/criteria_retrieval.py`) -- but it retrieves from
a fixed, hardcoded, ~7-item corpus (`CRITERIA_CORPUS`, req2ado's own authored checklist), not
from anything the user uploads. There is currently no ingestion path for a user's own
standards docs to reach scoring/link-analysis as always-on grounding.

**Design model: Open WebUI's own Knowledge feature.** User's explicit ask -- req2ado's KB
should behave the way Open WebUI's native Knowledge collections do, not invent a bespoke
scheme. Researched (docs.openwebui.com/features/workspace/knowledge/ +
github.com/open-webui/open-webui discussion #11227): Open WebUI ships exactly two retrieval
modes per knowledge file, not one --

- **Focused Retrieval (RAG)** -- today's req2ado behavior exactly: chunk, embed, top-k
  similarity search per query, inject only the highest-scoring chunks. Right for "search a
  large collection of similar past documents."
- **Full Context Mode** -- injects a file's ENTIRE content into every prompt, no chunking,
  no embedding, no similarity gate, unconditionally. Open WebUI's own docs frame this as
  "best for short reference documents, style guides, or context that's always relevant" --
  the exact shape of a CMMI/requirements-writing-standards doc: small, static, and its
  relevance is definitional, not topical, so a similarity score can never legitimately gate it.

**Proposed fix (not yet implemented):** add a per-KB-file mode toggle, mirroring Open WebUI's
own UI exactly -- "Always include" (Full Context) vs "Retrieve" (Focused/RAG, today's only
mode) -- set at upload time, stored alongside the file's existing KB metadata. `retrieve_context`
(`ingestion/app/kb/retrieval.py`) stays unchanged for "Retrieve" files. A new, small
always-fetch path reads every "Always include" file's full stored text unconditionally (no
embed call, no similarity gate) and concatenates it into `kb_context` ahead of/alongside
whatever `retrieve_context` returns -- so a scoring/analysis call sees BOTH the always-on
standards text AND whatever customer-content chunks cleared similarity, same as Open WebUI
blends Full Context files and RAG-retrieved chunks into one combined context for a single
prompt. Wire into the same points already threaded (`_score_all_requirements`/
`_apply_quality_scores` in `scoring.py`) and, longer-term, `trace_links.py` (currently
hardcodes `kb_grounded=False, kb_citations=[]` -- no KB grounding wired into trace-link
detection at all yet).

Practical bound worth calling out up front (Open WebUI's own docs imply this too --
"short reference documents"): Full Context mode has no size ceiling by design, so an
"Always include" file that's large enough to blow the prompt's context budget is a real
failure mode to guard against (e.g. a byte-size warning at upload time, or a hard cap with a
clear error) -- not handled by Open WebUI's own UI either, just something to not silently
reproduce.

**Scope note:** this is a real feature addition (new KB category, upload-time tagging,
ingestion path, retrieval helper, wiring into 2+ call sites), not a bug-fix-sized patch --
matches `req2ado-roadmap.md`'s own Phase 2 framing of "uploaded standards/glossary/rules
docs" as a distinct knowledge source, which today's implementation doesn't yet distinguish
from customer-content docs.

**Also flagged (UX, same session):** the `score_requirements` phase's `blocks_done`/
`blocks_total` chip is hardcoded to always read as 100% complete (`scoring.py`:
`blocks_done=blocks_total, blocks_total=blocks_total`) -- misleading during a phase that has
no real block-level progress to report. Recommend dropping that chip for this phase (or
replacing with a real `chunk N of M` indicator, since chunking is deterministic ahead of the
scoring loop) rather than showing a fabricated 100%-done metric next to the phase's own
"no fixed step count to measure against" disclaimer.

## 12. "Score" step's tooltip stays static during detect_conflicts/regroup_roots

**Status:** FIXED and deployed. Caught live on job `058f7298` (screenshot):
stepper shows "Score" as the current step with its spinner, while the narration bar
directly below correctly reads "Checking near-duplicate requirements for conflicting
values" -- the two lines visibly disagree about what's happening right now.

**Root cause:** NOT a step-index bug -- `reachedKeyFor` in
`frontend/src/components/JobLifecycleSteps.tsx:65-78` deliberately maps the
`detect_conflicts`/`regroup_roots` narration phases onto the "Score" step, on purpose,
per that function's own comment: both whole-tree passes run AFTER scoring finishes but
BEFORE `dedup_check`, and giving them their own step would regress the stepper backward
(a previously-fixed bug). That index mapping is correct and shouldn't change.

The actual gap: the step's tooltip is a single static string per step
(`stepDefs[reachedIndex].tip`, line 160) -- Score's tip ("Judging each drafted
requirement's quality...") never changes for the whole time "Score" is the reached step,
even though two functionally distinct sub-phases (scoring itself, then conflict
detection, then root regrouping) all render under it.

**Proposed fix (not yet implemented):** make the tooltip phase-aware -- when
`latestNarrationPhase` is `detect_conflicts` or `regroup_roots`, show a tip describing
that sub-phase instead of Score's fixed scoring text. One conditional near line 160 in
`JobLifecycleSteps.tsx`, no change to `reachedKeyFor`/`statesFor`/the stepper API.
Cosmetic/non-blocking -- the narration bar underneath already states the real activity
correctly, so nothing is factually wrong for the user, just inconsistent between the two
lines.

## 13. Stepper regresses from "Score" back to "Analyze" during infer_trace_links

**Status:** FIXED and deployed. Caught live on job `058f7298` (screenshot):
during trace/coverage link resolution the stepper jumped BACKWARD from "Score" to
"Analyze" (spinner on Analyze, Score shown as done-and-passed), while the narration bar
correctly read "Resolving trace/coverage links -- 545 of 545 blocks."

**Root cause:** real regression, same class of bug item 12's `detect_conflicts`/
`regroup_roots` guard was already built to prevent -- `reachedKeyFor`
(`frontend/src/components/JobLifecycleSteps.tsx:65-78`) only lists
`score_requirements`/`score_requirements_done`/`detect_conflicts`/`regroup_roots` as
mapping to the "Score" step. `infer_trace_links` was left out of that list, so it falls
through to the `else` branch (`key = 'analyze'`) -- exactly the backward-jump the
existing comment on that function says this logic exists to prevent, just missing this
one phase.

**Proposed fix (not yet implemented):** add `latestNarrationPhase === 'infer_trace_links'`
to the same condition (line 67-72) as `detect_conflicts`/`regroup_roots` -- it's another
whole-tree pass that runs after scoring, before `dedup_check`. One-line change, same
pattern as the existing guard, no new step/API change.

## 14. Existing-item verification is silently fail-open, and the ADO link's routing ambiguity can misreport "doesn't exist"

**Status:** IMPLEMENTED and deployed (part 1, the logging fix, and part 2, the project-scoped link). Surfaced live: a `dedup_skip` match on job
`058f7298` pointed at ADO work item `532`. Clicking through gave `TF401232: Work item 532
does not exist, or you do not have permissions to read it.` Investigation confirmed the
matched text is a byte-for-byte exact match to the drafted requirement (pulled directly
from the Chroma dedup collection) -- the match itself is not a false positive at the text
level. What's unresolved is whether ADO-side existing-item verification actually ran and
confirmed `532` before showing it, or silently no-opped.

**Root cause #1 -- silent fail-open, unobservable either way:**
`verifyExistingAdoIdsStillExist` (`orchestrator/src/modules/writeback/dry-run.service.ts:
169-192`) wraps its entire batch existence-check in `catch { return diff; }` -- no
logging, no warning surfaced anywhere. If the call throws for ANY reason (ADO outage,
expired credential, or a genuinely-missing id triggering some unexpected failure mode),
the diff is returned completely unchanged and there is zero trace anywhere that
verification was attempted, let alone failed. Orchestrator logs for this job show nothing
at all for this call -- consistent with either "never ran," "ran and threw," or "ran and
succeeded," which is exactly the problem: the three cases are indistinguishable from the
outside.

**Root cause #2 -- ADO's own error message is deliberately ambiguous, and req2ado's
server-side identity differs from a browser's:** `ado_get_work_items_batch`
(`mcp-ado-server/src/backends/realAdo.ts:226-239`) already requests `errorPolicy=Omit`,
which per ADO's documented contract should silently exclude an inaccessible/nonexistent id
from the batch response rather than throwing for the whole call -- that part looks correct
as written. But `TF401232`'s wording ("does not exist, **or** you do not have permission")
is intentionally ambiguous by ADO's own design, to avoid leaking existence info to an
unauthorized caller. req2ado's server-side reads go through one vaulted credential
(distinct from whatever ADO login a user's own browser session uses to click through a
result link) -- a permission gap on the browser side alone can produce this exact error
for an item the server-side check can read (and therefore correctly kept) just fine.
Compounding this, item 15's `orgUrl` trailing-slash bug means the link the browser
follows doesn't even include a project segment, which can independently cause ADO's web
routing to resolve the id against the wrong project context.

**Proposed fix (not yet implemented), two independent parts:**
1. Make the fail-open catch observable: log the caught exception (id list attempted,
   error message) and push a `warnings` entry onto the job (same convention every other
   fail-open dedup/scoring path in this codebase already uses) so a stale-or-failed
   verification pass is visible in the UI instead of indistinguishable from success.
   Small, safe, no behavior change to the fail-open decision itself -- only its visibility.
2. Build the work-item link with an explicit project segment instead of relying on ADO's
   org-level global redirect -- `job.areaPath`'s first segment (before the first `\`) is
   already the project name, available wherever `orgUrl`/`existingAdoId` are threaded
   (`ActionBadge.tsx`, `CollapsibleWarnings.tsx`). Removes the wrong-project-context
   routing ambiguity entirely, on top of (not instead of) the trailing-slash fix in item
   15's backlog.

**Scope note:** part 1 is a small, low-risk logging/observability change. Part 2 needs the
project name threaded down to both link call sites alongside `orgUrl`/`existingAdoId` --
slightly bigger than a one-liner but still localized to those two components.

## 15. `orgUrl` isn't normalized at login, producing a broken `//` in work-item links

**Status:** FIXED and deployed. Root cause of the `TF401232`-adjacent confusion
in item 14: `Login.tsx:44` passes the raw `adoOrgUrl` text-field value straight into
`authStore.login()` with no trimming or trailing-slash stripping. If the org URL is
entered (or configured) with a trailing slash, e.g. `https://dev.azure.com/elisradevops/`,
it's stored verbatim. `ActionBadge.tsx`/`CollapsibleWarnings.tsx` then build work-item
links as `` `${orgUrl}/_workitems/edit/${id}` ``, producing
`.../elisradevops//_workitems/edit/532` -- a double slash that reads as "the project
segment is missing" (it never had one by design -- this link pattern is deliberately
org-only, relying on ADO's own global id-to-project redirect) but can also just break or
misroute the request.

**Proposed fix (not yet implemented):** strip trailing slash(es) at the point of storage
-- `adoOrgUrl.trim().replace(/\/+$/, '')` before calling `login()` in `Login.tsx:44`.
One line, no schema change, no effect on already-correct URLs. Pairs with item 14's part 2
(adding an explicit project segment) as the more complete fix for that item's link-routing
ambiguity.

## 16. describe_figure/table_detected narration has no real total to show progress against (BACKLOG, not yet implemented)

**Status:** SPEC ONLY. No code changed. User asked live: since figure/table counts are
known, can the progress bar show "figure 3 of 39" during parsing instead of the current
open-ended "figure 3 so far"?

**Root cause:** the docx/pptx/pdf loaders (`ingestion/app/loaders/docx_loader.py` etc.)
walk the document linearly and call `describe_figure` SYNCHRONOUSLY as each image is
encountered mid-walk -- there is no upfront count available before that walk starts.
`parse_done` does report a real `figure_count`/`table_count` (`main.py`'s `/ingest` route),
but it only fires AFTER the whole walk (and every vision call) finishes -- too late to
help the progress bar during the very phase it would matter for.

**Proposed fix (not yet implemented):** add a lightweight "count-only" pre-pass per loader
type (docx/pptx/pdf) that scans for the same blip/drawing and table elements the real walk
already looks for, but does nothing with them -- no vision calls, no image bytes read, just
XML/structure iteration. Run once at the top of `/ingest`, before the real parse, to get
real totals up front, then thread `figure_count`/`table_count` into the `describe_figure`/
`table_detected` narration payloads so the UI can show a real "N of TOTAL" instead of an
open-ended counter.

**Scope note:** three near-duplicate walks to maintain (count-only, the real walk, and
whatever loader-specific logic already exists) -- one pre-count function per loader type,
plus wiring the resulting totals through `main.py`'s narration calls. Cost is negligible
(structural XML iteration, not the slow part -- vision calls are), but it's a real
multi-file change, not a one-liner.

## 17. Job `a830aa30` failed after ~66-74 min -- two cascading client-side timeouts, real culprit (LLM backend slowness) unconfirmed

**Status:** ROOT-CAUSED partially, NOT fixed. No code changed yet. Live incident, same
document as job `bb97b9a0` (which completed fine minutes earlier). `Job.status` shows
`failed`; `AuditEntry` shows `"Pipeline failed: fetch failed"`.

**What actually happened, in order (confirmed from JobEvent timestamps + container logs):**
1. Job created 10:08:11. Parsing, deterministic-subtree work, and 2 of 3 scoring batches
   completed normally (batch 2 done at 10:56:51 -- comparable pace to `bb97b9a0`).
2. **11:14:48** (66m37s after job creation) -- orchestrator's `IngestionHttpClient.level()`
   call to ingestion's `/level` throws `TypeError: fetch failed` /
   `HeadersTimeoutError (UND_ERR_HEADERS_TIMEOUT)`. Root cause: `LONG_RUNNING_AGENT`
   (`orchestrator/src/modules/pipeline/ingestion-http.client.ts:19`) sets
   `headersTimeout: 3_600_000` (exactly 1 hour) -- this job's `/level` call had been
   in flight since job creation and crossed that ceiling. Orchestrator gives up here,
   marks the job `failed`, and discards everything ingestion has computed so far --
   confirmed ingestion itself never crashed or restarted (container uptime checked).
3. **11:42:53** (~28 min AFTER orchestrator already gave up) -- ingestion's OWN `/level`
   call, still running in the background unaware its client had already disconnected,
   finally throws `ReadTimeout` from inside `OrchestratorLlmClient`'s httpx call to the
   LLM proxy (`_LLM_REQUEST_TIMEOUT_SECONDS = 1800.0`,
   `ingestion/app/survey/orchestrator_llm_client.py:48`) and publishes a real `job_failed`
   narration event (`errorType: "ReadTimeout"`, `lastPhase: "score_requirements"`) -- but
   by then the orchestrator had already marked the job failed and moved on, so this
   second, more informative failure event arrived too late to matter.

**Root cause of the SYMPTOM (client-side timeout mismatch):** two independent timeouts
guarding the SAME underlying slow call, at two different layers, with the orchestrator's
(1 hour, wall-clock from job start) firing before ingestion's own (30 min per LLM call,
apparently after some retry/compounding -- the observed 4432s exceeds one bare 1800s
window) resolves either way. Straightforward mitigation: raise
`LONG_RUNNING_AGENT`'s `headersTimeout`/`bodyTimeout` well above any realistic SURVEY
duration (e.g. 4 hours) -- one-line constant change. The existing stale-job watchdog
(60 min of *inactivity*, item 8) already covers the genuinely-hung case; a flat 60-minute
wall-clock ceiling on top of that only kills healthy-but-slow jobs.

**Root cause of the REAL underlying slowness -- NOT YET CONFIRMED:** why did this
scoring batch's LLM call take over an hour (vs. a comparably-sized batch on job
`bb97b9a0` finishing in ~30-40 min minutes earlier, same document, same model)? Ollama/
Open WebUI run on the host (not containerized in this compose stack), so their own
logs/resource state weren't inspected from this session. Plausible causes, unconfirmed:
host resource contention (multiple SURVEY jobs run back-to-back today), a model-reload
stall, or a genuinely stuck backend request. **Needs investigation with direct access to
the Ollama/Open WebUI host process next time this reproduces** -- the timeout-raise fix
above prevents PREMATURE failure, but does not explain or fix the underlying slowness
if it's a real, recurring backend problem rather than one-off contention.

**Proposed fix (not yet implemented):** raise `LONG_RUNNING_AGENT`'s timeouts in
`ingestion-http.client.ts:19` (small, safe, immediate mitigation), AND separately
investigate Ollama/Open WebUI's own state/logs the next time a scoring call runs
unusually long, before assuming the raised timeout alone is a complete fix.

## 18. NodeDetailPanel's description preview doesn't match what actually gets written to ADO (BACKLOG, not yet implemented)

**Status:** SPEC ONLY. No code changed. User asked about `System.Description`'s ADO field
type (`"type": "html"`) and wanting "nicely formatted text" consistently in both the
review UI and the real ADO work item.

**Root cause:** investigated end to end -- two of three layers already agree that
`description` is markdown, converted to real HTML: orchestrator's write-back
(`orchestrator/src/modules/pipeline/description-html.ts`'s `toAdoDescriptionHtml()`,
used at `jobs.service.ts:875`) runs the description through `marked.parse()` before
sending it to ADO's `System.Description`, and the frontend's `NodeDetailPanel.tsx:219`
already renders it through `<Markdown>` (react-markdown + remarkGfm), not a plain `<p>`.
Markdown formatting (**bold**, lists) already round-trips correctly today if the LLM
produces it (see item 19 for why it currently doesn't).

**The real, confirmed inconsistency:** BASELINE mode folds raw HTML `<table>` fragments
directly into a node's description (`ingestion/app/leveling/tree_builder.py`'s
`_table_to_html`) -- `toAdoDescriptionHtml()` has a `TABLE_BLOCK_PATTERN` carve-out that
passes these through untouched (correctly rendered once written to ADO). But the
frontend's react-markdown has no `rehype-raw` plugin, so that SAME raw HTML renders as
literal escaped text in the review UI, not as a table. A reviewer sees something
different from what will actually be written -- a "preview lies" bug, not a formatting
gap.

**Proposed fix (not yet implemented):** make the frontend preview render the exact same
HTML the write-back path will send, so review matches reality. Options: run the same
markdown+table-passthrough conversion client-side (port or share `toAdoDescriptionHtml`'s
logic) and render the result through a sanitized HTML renderer, OR add `rehype-raw` to
`NodeDetailPanel`'s `<Markdown>` config scoped ONLY to the already-trusted, already-escaped
table fragments ingestion produces (never arbitrary raw HTML from elsewhere). Small,
well-scoped once the approach is picked.

## 19. SURVEY-drafted descriptions never use markdown formatting (BACKLOG, not yet implemented)

**Status:** SPEC ONLY. No code changed. Distinct from item 18 (that's a render-consistency
bug; this is a content-generation gap) -- user wants "nicely formatted text," and today's
SURVEY output is flat, unformatted prose.

**Root cause:** `OrchestratorLlmClient`'s section-analysis prompt
(`ingestion/app/survey/orchestrator_llm_client.py:280-296`) asks the model for "a single
formal shall-style requirement statement" with no instruction to use markdown structure
at all (bold key terms, bullet lists for multi-part conditions, etc.). The write-back and
frontend render paths already fully support markdown (see item 18) -- the model simply
never produces any.

**Proposed fix (not yet implemented):** extend the section-analysis prompt to
instruct/permit markdown formatting for genuinely multi-part or emphasis-worthy content
(e.g. a compound condition as a bullet list, a key parameter name in bold) -- a prompt
change, not a plumbing change. Needs care: SURVEY's contract is a single formal
requirement statement per node, so formatting should enhance readability of that one
statement, not fragment it into something that no longer reads as one requirement.
Should be validated against real documents (does the model actually produce useful
structure, or just decorative noise) before considering it done.

## 20. No way to attach relevant figures/tables to a work item, LLM-judged (BACKLOG, not yet implemented)

**Status:** SPEC ONLY. No code changed. User asked whether a work item can get relevant
figures/tables appended to its description, with the LLM deciding relevance.

**Root cause / current state (confirmed via investigation, nothing exists today):**
- `WorkItemNode`/`SourceRef` (`ingestion/app/workitem/model.py`) never links to a
  specific `Figure`/`Table` id -- `SourceRef` only carries `document_path`/
  `start_offset`/`end_offset`/`page`. Figure captions and table content DO reach the
  synthesis LLM as context (folded into node text via `[FIGURE: ...]` markers and
  markdown/HTML table rendering) but once folded in, there's no back-reference to which
  Figure.id/Table.id produced that content.
- `mcp-ado-server` has **zero attachment capability** -- confirmed via
  `grep -rn "attachment" mcp-ado-server/src/`, zero hits. Its tools only set field
  values (`ado_create_work_item`/`ado_set_fields`); there is no upload-a-file-to-a-
  work-item tool of any kind.
- Attaching the *source document itself* to a work item was already evaluated and
  explicitly REJECTED in an earlier design pass (`jobs.service.ts:284-293` -- no object
  storage exists, and appending it to `System.Description` would violate BASELINE's
  verbatim-fidelity contract). Figures/tables are a narrower case but hit the exact same
  missing infrastructure (no attachment mechanism exists at all, for anything).

**Proposed fix (not yet implemented), three real pieces:**
1. Give the synthesis LLM call the candidate figures/tables (id + caption/content) for
   the section it's working on, and have it name which one(s) (if any) are relevant to
   the requirement it's drafting -- a real relevance JUDGMENT, not "attach everything
   nearby."
2. Tables are the easy half -- content can be embedded directly in the description as
   HTML (`_table_to_html` already exists) once a node names which table it wants.
3. Figures need REAL ADO attachment upload -- a genuinely new mcp-ado-server tool
   (`POST .../_apis/wit/attachmentsuploads` + linking the uploaded attachment into the
   work item, then referencing it via an `<img>` tag pointing at the attachment URL in
   the description HTML). Nothing today uploads anything to ADO; this is new surface
   area on the write-back path, not a small extension of existing tools.

**Scope note:** this is the largest of the three items logged today -- new LLM-judgment
step, new data linking (figure/table id -> node), and genuinely new ADO write capability
(file upload) that doesn't exist anywhere in this codebase yet.
