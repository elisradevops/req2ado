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

**Status:** FIXED and deployed. Found while watching item 3's live confirmation.

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

**Implemented fix:** two changes, together closing the real gap (distinguishing the phases),
not just the literal `etaText` string:
1. `isTailPhase` (`ProgressBanner.tsx`) was narrowed to drop `score_requirements`/
   `score_requirements_done` -- scoring now gets real `blocksDone`/`blocksTotal` progress
   (see item 11's "Also flagged" chip fix) instead of the generic tail label, cutting the
   affected phase count from five to three (`detect_conflicts`, `regroup_roots`,
   `infer_trace_links`).
2. A dedicated per-phase step list was added to the tail-phase view (`ProgressBanner.tsx`,
   the block rendering "Scoring requirement quality" / "Checking for conflicting
   near-duplicates" / "Grouping disconnected sections by topic" / "Resolving trace links",
   each with its own Check/Spinner/Circle state) -- so the engineer sees exactly which of
   the four tail steps is active/done/pending, not just one undifferentiated "Finishing
   up..." line. The top-level `etaText` still shows "Finishing up…" as a summary for the
   three remaining tail phases, but it's no longer the ONLY signal -- the step list beneath
   it removes the "1 or 5 remaining phases look identical" failure mode this item reported.

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

## 11. KB retrieval treats standards/methodology docs the same as customer-content docs

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

**Implemented fix:** the per-KB-file mode toggle shipped exactly as proposed -- a
`retrieval_mode` field ("retrieve" (default) vs "always_include") set at upload time
(`ingestion/app/kb/ingest_service.py`, `kb_vector_store.py`), stored alongside the file's
existing KB metadata. `retrieve_context` (`ingestion/app/kb/retrieval.py`) is unchanged for
"retrieve" files. `fetch_always_include_context` (`retrieval.py`) reads every
"always_include" file's full stored text unconditionally (no embed call, no similarity
gate) and concatenates it into `kb_context` alongside whatever `retrieve_context` returns.
Wired into `scoring.py`'s call sites as planned; `trace_links.py`'s KB grounding remains the
noted longer-term follow-up, not yet done.

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

**Also flagged (UX, same session) -- FIXED:** the `score_requirements` phase's `blocks_done`/
`blocks_total` chip was hardcoded to always read as 100% complete. `scoring.py`'s `_fire`
closures now report real `nodes_done`/`total_nodes` plus `chunk_index`/`chunk_count` (the
"real `chunk N of M` indicator" this note recommended), not a fabricated 100%-done metric.

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

**Implemented fix:** the tooltip is now phase-aware exactly as proposed -- conditionals
near `JobLifecycleSteps.tsx`'s tip assignment (`if (reached === 'score' &&
latestNarrationPhase === 'detect_conflicts') ... else if (... === 'regroup_roots') ...`)
override Score's static tip with sub-phase-specific text, with no change to
`reachedKeyFor`/`statesFor`/the stepper API.

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

**Implemented fix:** `latestNarrationPhase === 'infer_trace_links'` was added to the same
condition in `reachedKeyFor` as `detect_conflicts`/`regroup_roots` -- one-line change, same
pattern as the existing guard, no new step/API change. The tooltip for this phase also got
the same phase-aware treatment as item 12's fix.

## 14. Existing-item verification is silently fail-open, and the ADO link's routing ambiguity can misreport "doesn't exist"

**Status:** IMPLEMENTED and deployed (part 1, the logging fix, and part 2, the project-scoped link) -- **and Root cause #1 below was later found to be WORSE than "unobservable," and independently fixed for real** (see item 21). Surfaced live: a `dedup_skip` match on job
`058f7298` pointed at ADO work item `532`. Clicking through gave `TF401232: Work item 532
does not exist, or you do not have permissions to read it.` Investigation confirmed the
matched text is a byte-for-byte exact match to the drafted requirement (pulled directly
from the Chroma dedup collection) -- the match itself is not a false positive at the text
level. What's unresolved is whether ADO-side existing-item verification actually ran and
confirmed `532` before showing it, or silently no-opped.

**Update (2026-08-06):** the same job `532` symptom recurred on a fresh job (`ba8c26d1`),
and this time was root-caused precisely rather than left as an open question -- see item 21.
It was not merely "unobservable either way" as guessed below: `verifyExistingAdoIdsStillExist`
was actively **crashing** on a `null` placeholder ADO returns in place of a genuinely-deleted
id, which silently defeated the existence check for the ENTIRE batch (confirmed: 37 matches
went unverified in that one job, not just 532). Item 21 fixes the crash itself, which is a
strictly more complete fix than this item's part-1 proposal (logging the fail-open catch) --
the catch is no longer reached for this failure mode at all.

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

**Implemented fix:** `Login.tsx` now normalizes at the point of storage --
`adoOrgUrl.trim().replace(/\/+$/, '')` before calling `login()`. One line, no schema
change, no effect on already-correct URLs. Pairs with item 14's part 2 (the explicit
project segment) as the complete fix for that item's link-routing ambiguity.

## 16. describe_figure/table_detected narration has no real total to show progress against

**Status:** FIXED and deployed for .docx (936 ingestion tests pass, including 2 new
dedicated tests plus extended assertions on an existing end-to-end `/ingest` test); other
formats deferred, see below. User asked live: since figure/table counts are known, can the
progress bar show "figure 3 of 39" during parsing instead of the current open-ended
"figure 3 so far"?

**Root cause:** the docx/pptx/pdf loaders (`ingestion/app/loaders/docx_loader.py` etc.)
walk the document linearly and call `describe_figure` SYNCHRONOUSLY as each image is
encountered mid-walk -- there is no upfront count available before that walk starts.
`parse_done` does report a real `figure_count`/`table_count` (`main.py`'s `/ingest` route),
but it only fires AFTER the whole walk (and every vision call) finishes -- too late to
help the progress bar during the very phase it would matter for.

**Correction found while implementing:** `table_detected` didn't actually need a pre-count
at all -- it already fires from a `for table in doc.tables:` loop in `main.py`, AFTER the
real parse completes (`doc` is the fully-parsed document by then), so `len(doc.tables)` was
already trivially available. Only `describe_figure` genuinely needed a pre-pass, since it
fires DURING the walk, before the full figure list (and its count) exists.

**Implemented fix:**
1. `table_detected`: the existing loop switched to `enumerate(doc.tables, start=1)`,
   passing a new `table_index` field alongside the already-existing `table_count` -- zero
   new parsing cost, the data was already sitting right there.
2. `describe_figure`: `main.py`'s `/ingest` now runs one cheap, structural-only pre-pass
   (`dispatch_by_extension(..., describe_figure=None)` -- `_describe_one_figure` short-circuits
   before ever reading image bytes, so no vision calls happen) ahead of the real walk,
   **scoped to `.docx` for now** (the reproducing case, and the only format with no OCR
   step to double the cost of). `figure_count` (already an existing field, previously
   `parse_done`-only) is now also populated on `describe_figure` events with this
   pre-counted total. `_format_message` (`narration_publisher.py`) shows "figure N of
   TOTAL" when `figure_count` is present, falling back to the old "figure N so far" when
   it isn't (unsupported format, or vision/narration inactive).

**Deferred, not silently dropped:** pptx/pdf still show the open-ended "figure N so far"
wording -- pdf's OCR path does real work regardless of `describe_figure`, so blindly
doubling the walk there isn't the same negligible-cost trade docx gets. Extend per-format
only if that format shows the same live gap docx did.

## 17. Job `a830aa30` failed after ~66-74 min -- two cascading client-side timeouts, real culprit (LLM backend slowness) unconfirmed

**Status:** Timeout mismatch FIXED; underlying slowness now explained (see update below).
Live incident, same
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

**Implemented fix (timeout mismatch):** `IngestionHttpClient`'s `Agent` now takes a
`requestTimeoutMs` constructor param (`ingestion-http.client.ts`, wired from the new
`INGESTION_REQUEST_TIMEOUT_MS` env var in `jobs.module.ts`) instead of a hardcoded
constant -- deployments can raise it above the default (`DEFAULT_INGESTION_REQUEST_TIMEOUT_MS`,
still 1 hour) for realistically long SURVEY runs without a code change. The default itself
was deliberately left unchanged rather than blanket-raised, since the stale-job watchdog
(item 8) already covers the genuinely-hung case and a much longer default would only delay
detecting a real cascading failure like this one.

**Underlying slowness -- explained, not left open:** a later investigation
(`docs/survey-performance.md`) found the actual dev-environment Ollama backend runs with
exactly one concurrent generation slot (`-np 1`, `llama-server`'s default when
`OLLAMA_NUM_PARALLEL` is unset) -- this job's LLM calls were never concurrent, so any
resource contention or model-reload stall serializes directly into wall-clock time with no
isolation between jobs. `SURVEY_BRANCH_CONCURRENCY` shipped as the scalable answer (bounded
concurrent branch analysis, opt-in, defaults to sequential/unchanged) -- see that doc for
the production rollout recommendation (coordinate with the backend's real concurrent
capacity before raising it).

## 18. NodeDetailPanel's description preview doesn't match what actually gets written to ADO

**Status:** FIXED and deployed (380 frontend tests pass, including 5 new dedicated
tests). User asked about `System.Description`'s ADO field
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

**Implemented fix:** a new `DescriptionMarkdown` component (`frontend/src/ui/Markdown.tsx`)
splits a description on the same `TABLE_BLOCK_PATTERN` regex `description-html.ts` uses,
renders non-table segments through the existing (raw-HTML-blind) `Markdown`, and renders
each trusted table segment as real `<table>/<tr>/<td>` React elements via a small
regex-based cell extractor (mirroring `_table_to_html`'s known, fixed output shape) plus
an `html.escape` un-escaper for cell text -- no `dangerouslySetInnerHTML`, no `rehype-raw`
dependency added, so the shared chat `Markdown` (untrusted LLM text) stays exactly as
raw-HTML-blind as before. Wired into `NodeDetailPanel.tsx` only, in place of the plain
`Markdown` call.

## 19. SURVEY-drafted descriptions never use markdown formatting

**Status:** IMPLEMENTED, needs live validation. Distinct from item 18 (that's a
render-consistency bug; this is a content-generation gap) -- user wants "nicely formatted
text," and SURVEY output was flat, unformatted prose.

**Root cause:** the live section-analysis prompt (`ingestion/app/prompts/
section_analysis.v1.txt` -- the doc's originally-cited `orchestrator_llm_client.py:280-296`
location predates the holistic-analysis redesign and no longer describes the current
prompt) asked the model for "a single formal shall-style requirement statement" with no
instruction to use markdown structure at all. The fallback, non-agentic
`generate_requirements.v1.txt` prompt has the same gap, but its caller
(`build_survey_requirements.py`) is dead code -- confirmed via repo-wide grep, referenced
only by its own tests, never invoked from `main.py`/`llm_leveling.py` -- so it was left
unchanged rather than edited for no live effect. The write-back and frontend render paths
already fully support markdown (see item 18) -- the model simply never produced any.

**Implemented fix:** extended `section_analysis.v1.txt`'s `'text'` field instruction to
permit (not require) markdown formatting for genuinely multi-part or emphasis-worthy
content -- bold for a key parameter/value, a bullet list for a compound multi-part
condition -- while explicitly keeping the existing one-statement-per-node contract intact
("never as a way to fragment it into multiple separate obligations").

**Still needed before calling this fully done:** validate against 2-3 real documents with
genuinely compound conditions to confirm the model produces useful structure, not
decorative noise -- a prompt change's real effect can't be asserted by a unit test alone.

## 20. No way to attach relevant figures/tables to a work item, LLM-judged

**Status:** Pieces (a)/(b)/(c) IMPLEMENTED and unit-tested (945 ingestion tests including
9 new dedicated tests, 576 orchestrator tests, 382 frontend tests all pass). Verified live
end-to-end, including real per-node relevance judgment and real table embedding, on a
synthetic document; two further real-document runs of the same large real AirPro doc
confirmed no regressions/crashes but never actually exercised the new code path at all,
since that document is fully deterministically classified (see below for all three runs).
Piece (d) -- real ADO figure attachment upload -- remains deferred, needs a storage-layer
decision (see its own section below). User asked whether a work item can get relevant
figures/tables appended to its description, with the LLM deciding relevance.

**Root cause / original state (confirmed via investigation; figure_ids/table_ids below
close the "no back-reference" gap for (a)/(b)/(c) -- the attachment-upload gap for
figures, piece (d), is still real and unchanged):**
- `WorkItemNode`/`SourceRef` (`ingestion/app/workitem/model.py`) never linked to a
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

**Blocker found while scoping the implementation, solved:** `render_section`
(`ingestion/app/leveling/llm_leveling.py`) -- what the LLM actually reads for SURVEY
analysis -- rendered a figure via `_render_block_line` -> `_figure_line` as bare
`[FIGURE: <caption>]`, and a table via `_table_to_markdown`, neither ever including the
underlying `Figure.id`/`Table.id` -- the model had no identifier to name back in a
"relevant to figure X" judgment. Solved WITHOUT touching `_figure_line`/`block.text`
(shared verbatim with BASELINE's `_FIGURE_TEXT_PATTERN`-anchored parsing and
`llm_leveling.py`'s own coverage-check string-matching, both of which must stay
byte-identical): `render_section` now takes an optional `figure_id_by_block_id` map
(`block.id -> Figure.id`, built once per document in `build_survey_tree` by pairing
`doc.blocks`' FIGURE-kind blocks with `doc.figures` in loader-append order -- every
loader, docx/pptx/pdf, appends a Figure and its paired inline Block in lockstep, confirmed
directly in each loader's source) and post-processes `_figure_line`'s own output string
(`"> Figure: caption"` -> `"> Figure f3: caption"`) rather than mutating the shared
function. Tables needed no such trick -- `table.id` was already directly in hand from the
`tables` list itself; each table now gets a `[TABLE <id>]` marker line immediately above
its rendered rows.

**Implemented fix, all three pieces:**
1. **Data linking + LLM judgment (a+b):** `WorkItemNode` gained `figure_ids`/`table_ids`
   (`ingestion/app/workitem/model.py`, and the shared `work-item-tree.schema.json` +
   regenerated `shared/ts/src/generated/WorkItemTree.ts`). `section_analysis_schema()`
   (`ingestion/app/survey/_response_schemas.py`) gained matching optional array-of-string
   properties on each node (unbounded, no `maxItems` -- confirmed this doesn't reintroduce
   the bounded-repetition GBNF grammar-cost cliff the module's own header docstring warns
   about, since it's the same shape as the already-safe `tags` field). `section_analysis.v1.txt`
   instructs the model to copy a figure/table's real id verbatim when (and only when) a
   node is genuinely about it. The node-building loop in `_build_survey_tree_for_branch`
   validates every returned id against this branch's own real candidate ids (derived from
   its own `blocks`/`tables`, not the whole document) -- a hallucinated id is dropped with
   a warning, never trusted verbatim, matching the same fail-safe convention every other
   LLM-output field here already uses.
2. **Table embed (c):** once a node names a real `table_id`, that table's HTML
   (`_table_to_html`, already existed) is embedded into `description` via
   `assemble_description` -- no new ADO write capability needed. `fidelity_hash` was
   switched to hash the FINAL `description` (text + embedded table), not just the LLM's
   raw `text`, so drift detection actually tracks the persisted field.
3. **Figures (d): still deferred.** `figure_ids` is link-only today -- recorded on the
   node, but nothing uploads the actual image anywhere (see below, unchanged from the
   original scoping).

**Verified live end-to-end** (not just unit tests): real SURVEY run against `qwen3.6:35b`
on a synthetic docx with one 3-row rail-voltage table and three per-rail requirements
(job `cc124254-3650-4531-b5e7-57ba690fc5ba`) -- the model correctly named the table's real
id (`t0`) on all three rail-specific requirements (3.3V/5V/12V), each showing the table's
real HTML embedded in its description, while a fourth, thermal-unrelated requirement
(Fan Speed Control Logic) correctly got no table at all -- a genuine per-node relevance
judgment, not blanket attachment. Confirmed via `docker compose ps`/`logs`: this exposed
that the `frontend`/`ingestion` containers hadn't been rebuilt since today's earlier fixes
landed -- item 18's table-rendering fix (and every other fix from today) only took effect
in the live app after `docker compose build ingestion frontend && docker compose up -d
ingestion frontend`. No errors in ingestion/orchestrator logs across the full run.

**Second attempt, real 39-figure/5-table document -- did not reach diff_ready, root cause
confirmed environmental, not a code defect:** also uploaded the real `AirPro_BP_ICD_
Revision_0.3.docx` (job `40a926d2-ec55-4dd9-825b-d38889dc355a`) to additionally validate
`figure_ids` against real figures. Parsing and item 16's narration confirmed correct on
this real document ("figure 20 of 39", "table 1 of 5", etc.), and analysis progressed
genuinely (deterministic-subtree extraction, then `score_requirements` batch 1 of 3) for
~80 real minutes. The job was then auto-cancelled by the stale-job watchdog (item 8) after
`/llm/chat` returned a 500 at 22:49:50, and the SAME retry call (per
`orchestrator_llm_client.py`'s `_post_chat` backoff loop) didn't get its next response
until 23:31:51 -- a ~42-minute single HTTP call, confirmed via `sysctl vm.swapusage`
(6.2GB/7.2GB swap in use at the time) to be host memory-pressure thrashing, the EXACT
confound `docs/survey-performance.md` already root-caused and documented (this session ran
two concurrent SURVEY jobs plus two `docker compose build` runs on the same single-slot-
Ollama dev machine). The watchdog itself worked correctly, per its own design, once its
full worst-case window elapsed. Not re-attempted -- re-running against an already-swapping
host would likely reproduce the same environmental confound rather than yield new signal.
**Conclusion: this failure is unrelated to item 20's own changes** -- everything item 20
touches (figure/table id rendering, narration, table embedding) behaved correctly on this
document up to the point analysis stalled on backend slowness; the actual figure_ids-on-
real-figures path remains unverified live (only unit-tested), pending a retry on an
otherwise-idle machine.

**Third attempt, same real document, resubmitted on a quieter host -- reached diff_ready
cleanly, but a genuine negative result for figure_ids/table_ids specifically:** re-uploaded
the identical `AirPro_BP_ICD_Revision_0.3.docx` (job `dfda991d-b652-40a0-91ab-7c5c5b4de0bf`)
with lower starting swap (3.9GB/5GB vs the failed run's 6.2GB/7.2GB). Completed end to end
in ~55 minutes, 553 diff entries, zero errors in ingestion/orchestrator/pipeline-worker
logs. Confirmed via Playwright: a real table (from the document's own FAN/GPU configuration
data) renders as a genuine HTML `<table>` in "GPU Zodiac Module"'s description -- item 18's
render fix and the deterministic-path table embedding it's built on remain solid on real
content.

**However:** `SELECT count(*) FROM "JobEvent" WHERE "jobId" = '...' AND phase =
'analyze_section'` returned **0** for this run -- the holistic LLM-analysis call that
item 20's `figure_ids`/`table_ids` logic lives inside never fired at all. This document is
(as already noted elsewhere in this doc, item 3) heavily/fully deterministically
classified -- `_detect_deterministic_subtrees` claims essentially the whole document via
its "Heading hierarchy" subtree, so `llm_doc.blocks`/`figures`/`tables` is empty and
`build_survey_tree`'s pure-deterministic guard returns before `_build_survey_tree_for_branch`
(and therefore `render_section`'s figure/table id injection, and the relevance-judgment
prompt) ever runs. The 5 `<table>`-bearing nodes confirmed in this run's `dryRunDiff`
(`det0_h11_3`, `det0_h11_4`, `det0_h11_5`, `det0_h13`, `det0_h70_2` -- all `det0_`-prefixed,
i.e. deterministic-path node ids, never `br0_`/unprefixed LLM-path ids) come from
`tree_builder.py`'s own pre-existing, unrelated `_table_to_html` usage in the deterministic
heading-walk, not from item 20's new `table_ids` mechanism. No `figure_ids`/`table_ids`
hallucination warnings appear in the ingestion logs either, consistent with the LLM path
simply never running rather than running and succeeding silently.

**Net effect:** item 20's own code is now confirmed stable through two full real-document
runs (no crashes, no regressions) and its logic is fully verified on the ONE synthetic
document that actually exercises `analyze_section` (job `cc124254-...`, see above). But
`figure_ids`/`table_ids` acting on genuinely LLM-analyzed real figures/tables is still
**not** demonstrated live -- this specific real document's own content structure (a fully
deterministic ID/heading hierarchy) makes it structurally unable to reach that code path
at all, regardless of host performance. A live demonstration on real figures would need a
document (or a document section) that ISN'T fully ID/heading-hierarchy-shaped, so some real
content actually reaches `analyze_section`.

**Scope note, still accurate:** figures (piece d) remain the largest deferred piece --
genuinely new ADO write capability (file upload) that doesn't exist anywhere in this
codebase yet.

**Also noted (not a blocker):** orchestrator's `dryRunDiff` mapping is a deliberately
curated projection of `WorkItemNode` (confirmed live via direct DB query: it already omits
several other ingestion-only fields, e.g. `fidelityHash`/`identityHash`) and does not
currently carry `figureIds`/`tableIds` through to the persisted diff -- the feature works
end-to-end regardless, since table embedding happens entirely on the ingestion side before
`description` is finalized, but the judgment metadata itself isn't separately queryable
from the orchestrator/frontend today. Surfacing it (e.g. for a future "linked to Figure 3"
chip, mirroring `KbCitationChips`/`TraceLinkChips`) is a real but separate follow-up, not
required for this item's own acceptance criteria.

## 21. Stale-ADO-item verification silently crashed on a `null` placeholder, defeating the whole batch (item 14's root cause, found precisely)

**Status:** FIXED and deployed (88 mcp-ado-server, 934 ingestion, 576 orchestrator tests
pass). User hit this live trying to confirm a job: `existingAdoId: 532` (deleted in ADO
9 days earlier by req2ado itself, per `CreatedItemMapping`) survived into the diff
completely unverified -- the exact symptom item 14 first spotted, this time root-caused.

**Root cause:** `RealAdoBackend.getWorkItemsChunk` (`mcp-ado-server/src/backends/realAdo.ts`)
assumed `errorPolicy=Omit` always drops a dead/deleted id from ADO's response array. It
doesn't always -- ADO can return a `null` entry in its place instead. `data.id` on that
`null` threw `Cannot read properties of null (reading 'id')`, which crashed
`getWorkItemsBatch` for the WHOLE batch, not just the one dead id. `dry-run.service.ts`'s
`verifyExistingAdoIdsStillExist` fail-opens on any thrown error (by design, for a genuine
ADO-outage case) -- so all 37 matched ids in this job went unverified, including 532,
identical in effect to item 14's "unresolved: did verification even run?" question, except
now with a confirmed, reproducible cause: it ran, and crashed, silently, every time.

**Implemented fix:** filter `null` entries out of the response array before mapping.
Idempotent, minimal -- the rest of the batch still verifies correctly; only the
dead-id slot is now correctly treated as "gone," matching what `errorPolicy=Omit`'s own
contract was supposed to guarantee. **New test**
(`mcp-ado-server/test/realAdo.test.ts`): a `null` array entry no longer crashes the batch,
the real (non-null) result still returns correctly.

## 22. `dedup_skip` stale matches had no cleanup path -- a deleted ADO item kept resurfacing forever

**Status:** FIXED and deployed (same test run as item 21). Direct consequence of fixing
item 21: once verification could actually run and downgrade item 532's match to `create`,
a SEPARATE gap surfaced -- the existing stale-match cleanup (`pipeline.worker.ts`, added
for the `reuse`/IdempotencyMapping case) only ever handled `reuse`, never `dedup_skip`.
Its own comment said so explicitly ("a known, separately-tracked gap, not fixed here").

**Root cause:** a `dedup_skip` match's Chroma vector entry has no delete path anywhere in
the codebase -- `ChromaVectorStore` supported `upsert`/`upsert_many`/`query_nearest` but no
`delete`. So even after verification correctly downgrades a stale match to `create` for
THIS job's diff, the dead id's embedding stays in the dedup corpus forever, and resurfaces
as a "match" on every future job against the same area path -- the exact behavior a live
resubmit test would have hit again immediately after item 21's fix alone.

**Implemented fix:** `ChromaVectorStore.delete(item_id, area_path)` (new,
`ingestion/app/dedup/vector_store.py`), a new `POST /dedup/delete` route (`main.py`), a new
`IngestionHttpClient.deleteDedupEntry()` (orchestrator), wired into `pipeline.worker.ts`'s
existing downgrade-cleanup block alongside the `reuse` case -- same best-effort,
never-fails-the-job semantics. **Verified live** on a real resubmit (job `b4ade6a6`): zero
`dedup_skip`/`reuse` entries remained pointing at 532 in the resulting diff, and ingestion
logs showed real `POST /dedup/delete -> 200 OK` calls firing for all downgraded matches.

## 23. Confirming a resubmitted document 400s ADO (`TF401349`) -- `reuse` matches were re-linked to a parent they already have

**Status:** FIXED and deployed (576 orchestrator tests pass). User hit this live clicking
Confirm on a resubmit of a document already confirmed once before (job `57b4f5cc`,
2026-07-28). Real ADO write partially succeeded then crashed: most items created and
linked, two (`det0_h3`->641, `det0_h6`->663) left unlinked when the batch aborted.

**Root cause:** ADO allows at most one Parent (`Hierarchy-Reverse`) relation per work item.
`JobsService.confirm`'s `toLink` filter (`jobs.service.ts`) already excludes `dedup_skip`
children (item 14/21's probabilistic-match case) but never excluded `reuse` -- an exact-
hash match to an item that already exists in ADO **with its own already-established Parent
relation from whenever it was originally created**. Re-adding that same relation on a
later job (any resubmit of unchanged content) 400s with ADO's generic `TF401349`, not a
friendly "already linked" error -- and `mapWithConcurrency` propagates that single failure
to abort the whole link phase, stranding whatever links hadn't started yet.

**Implemented fix:** exclude `entry.action === 'reuse'` from `toLink`, mirroring the
existing `dedup_skip` exclusion. **New test**
(`orchestrator/test/jobs.service.spec.ts`): a `reuse`-matched child is never passed to
`linkParentChild`. The existing per-job resume mechanism (`alreadyLinkedLocalIds`, P4b)
already skips items already marked `linked=true`, so a stranded job from before this fix
can simply be re-confirmed -- it picks up exactly where the crash left off.
