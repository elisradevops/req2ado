# UI/UX progress-monitoring review — live job walkthrough

Reviewed live via Playwright against a real running SURVEY job
(`AirPro_BP_ICD_Revision_0.3.docx`, 682 blocks, 39 figures, real ADO +
real Ollama backend) on 2026-08-05. Perspective: an ADO-savvy engineer who
does **not** know req2ado's internals and needs the UI alone to tell them
whether a long-running job (500+ page documents are the stated concern) is
progressing, stalled, or done.

Status legend: `OPEN` not started · `FIXED` implemented + verified · `DEFERRED` real gap, needs a design decision beyond a safe surgical fix.

**Deploy note:** #1 and #2 below are code-complete and test-verified but
**not yet in the running containers** — a real SURVEY job
(`ef026fea-d168-4578-937f-b3aa92f158bf`) is still `running` against real
Ollama at the time these fixes landed. Rebuilding/restarting the
`ingestion` container now would kill that job mid-run (BullMQ would
eventually reclaim and restart it once its lock lapses, but that discards
real, already-paid-for LLM progress). Deploy (`docker compose up -d
--build ingestion frontend`) once that job reaches a terminal state
(`diff_ready`/`succeeded`/`failed`/`cancelled`).

---

## 1. ETA estimate is hard-capped at 40 minutes regardless of document size

**Status: FIXED**

`frontend/src/utils/eta.ts`'s `computeEtaMinutes` clamps SURVEY's estimate
to `Math.min(40, 15 + blockCount * 0.5)`. For the 682-block document this
review used, the uncapped formula gives 356 minutes — the UI would have
told the engineer "~40 min" regardless. For the user's stated 500+ page
case this is actively misleading, not just imprecise: an engineer who
expects 40 minutes and is still waiting 3 hours later will reasonably
conclude the job is broken and cancel a job that was working fine the
whole time. A ceiling makes sense to stop tiny documents from showing a
scary number; it must never apply to large ones — underselling wait time
is worse than overselling it.

**Fix:** removed the upper clamp; kept the lower floor (`SURVEY_MIN_MINUTES`)
so tiny documents don't show a suspiciously small number.

**Files:** `frontend/src/utils/eta.ts`, `frontend/src/utils/eta.test.ts`

---

## 2. Chunked sub-passes report `blocks_total=0`, so the "no progress estimate" message shows even though the real fraction is already known server-side

**Status: FIXED**

`_apply_title_tag_pass` and the leaf-requirement-synthesis loop (both in
`ingestion/app/leveling/id_tree_builder.py`) already compute
`chunk_num`/`total_chunks`/`len(leaf_node_ids)` to build the narration
**text** ("chunk 1 of 2"), but hardcode `blocks_done=0, blocks_total=0`
on the `LevelingProgress` event they fire. `ProgressBanner.tsx`'s existing
(and already well-designed — see its own "never fabricate a percentage"
comment) progress calculation requires `blocksTotal > 0` to show a real
percentage; with both always 0, it always falls through to "Working — no
progress estimate for this step yet." even mid-chunk, mid-document. This
is exactly what was observed live: 2+ minutes on the same "chunk 1 of 2"
line with zero numeric signal, only elapsed-seconds ticking up.

**Fix:** pass `blocks_done=start, blocks_total=len(leaf_node_ids)` at both
call sites — the existing frontend math (no new frontend code needed)
then renders a real `~N% of this section (est.)` for these two passes.

**Files:** `ingestion/app/leveling/id_tree_builder.py`

**Not touched (correctly zero, left alone):** the per-subtree kickoff
event in `llm_leveling.py` (`_fire_subtree`) and the one-shot
`preparing_analysis` event — neither has a real "blocks" unit at that
granularity; both already use `subtree_index`/`subtree_count` or an
honest "no fixed step count" message instead of fabricating one.

---

## 3. Mid-run chunk failures are invisible until the job completes

**Status: FIXED**

Every chunked pass (title/tag enhancement, leaf synthesis, parent
summarization, scoring) does `warnings.append(message)` on a local Python
list when an individual chunk's LLM call fails. That list is still only
persisted to `Job.warnings` when the whole tree build finishes, but each
of the 6 call sites (`id_tree_builder.py`'s `_apply_title_tag_pass`,
`_apply_parent_summary_pass`, `_apply_synthesis_pass`; `scoring.py`'s
`_score_all_requirements`, `_score_epics_and_features`,
`_apply_quality_scores`) now ALSO fires a new `chunk_warning` narration
phase (`narration_publisher.py`) alongside the `warnings.append(...)` call,
carrying the same message verbatim via a new `warning_message` field —
`progress_callback` was threaded into `_apply_parent_summary_pass` and
`_apply_quality_scores`, the two functions that didn't already have it.

Frontend: `JobDetail.tsx`'s SSE handler captures `chunk_warning` events
into a `liveWarnings` state (deliberately excluded from the main
`narrations` array so it can never become the ticker/stepper's "latest
phase" and corrupt that display), and feeds a merged, deduped
`liveWarnings` ∪ `job.warnings` array into the existing
`CollapsibleWarnings` "N integrity warning(s)" component — reusing the
existing visual pattern rather than inventing a new counter widget, per
the original recommendation below.

**Files:** `ingestion/app/leveling/id_tree_builder.py`,
`ingestion/app/leveling/scoring.py`, `ingestion/app/leveling/narration_publisher.py`,
`frontend/src/api/events.ts`, `frontend/src/pages/JobDetail.tsx`,
`frontend/src/components/ProgressBanner.tsx`, `frontend/src/utils/narrationTicker.ts`

---

## 4. Activity log keeps only the last 50 events, both server- and client-side

**Status: FIXED for the reconnect-looks-like-data-loss case (382 frontend tests pass,
including 2 new dedicated tests); the raise-the-cap/retention tradeoff below is still an
open, separate question.**

`JobDetail.tsx`'s `setNarrations` does `.slice(-50)`, matching
`narration_publisher.py`'s own `_NARRATION_LOG_MAX_ENTRIES = 50` Redis-side
cap. For a short document this never matters. For a 500+ page document
running for hours with hundreds of narration events (parse, per-figure
vision captions, per-chunk analysis, scoring, dedup), the engineer can
only ever see the most recent ~50 — the page's own reassurance ("you can
close this page and come back") implies continuity the activity log does
not actually provide once a run has been going long enough.

**Why deferred:** raising the cap is a one-line change but has a real
cost/tradeoff (more Redis memory per job, more DOM nodes client-side —
this project's own conventions call for virtualization, per
`CLAUDE.md`'s `react-virtuoso`/`react-window` note, once a list can grow
unbounded) — bumping the number alone without addressing that tradeoff
would just move the wall further out, not fix the actual ceiling.

**Confirmed live, sharper than initially suspected:** navigated away from
the still-`running` job and back. The "N figure descriptions" panel
(previously showing all 39, confirmed captioned) came back showing only
**20**. Traced the root cause precisely, not just the symptom:
- `JobDetail.tsx` only fetches the durable, unbounded
  `/jobs/:id/event-history` (backed by Postgres's `JobEvent` table, `SELECT
  ... ORDER BY createdAt ASC`, genuinely no cap) once a job reaches a
  **terminal** status — for a still-`running` job it never fetches it at
  all.
- For a running job, the figure panel is instead seeded from
  `Job.figureDescriptions` (empty until the job finishes writing it) plus
  whatever `describe_figure` narration events the **current** SSE
  connection happens to receive after it (re)connects.
- Verified directly against the database: `JobEvent` has all 39 real
  figure-caption rows for this job (`SELECT count(*) FROM "JobEvent" WHERE
  "jobId" = '...' AND message LIKE 'Figure %:%'` → 39). Nothing was
  actually lost — the reconnect path only replays a bounded recent window
  (the same Redis narration-log the 50-cap above draws from), not the full
  Postgres history.
- **Impact:** an engineer who refreshes the tab (or reopens it after their
  laptop sleeps) mid-run — an entirely normal thing to do during a
  multi-hour SURVEY run on a 500+ page document — sees the figure/activity
  counts apparently **regress**, which reads as data loss or a stuck/broken
  job, when the real pipeline is completely unaffected. This is more
  alarming than "can't scroll back," and specifically punishes the exact
  usage pattern (leave it running, come back later) the page's own copy
  invites ("You can close this page and come back").

**Implemented fix:** exactly the recommendation above. `JobDetail.tsx`'s event-history
effect now fetches on every mount regardless of status (the `pending`/`running`/`writing`
early-return was removed) -- the durable `/event-history` source a terminal job already
used is now used for a running job too. A new `mergedNarrations` (`useMemo`) combines it
with the bounded live SSE tail: `JobEventPersistenceService` (orchestrator) already stores
each event's raw payload verbatim in its `detail` column -- the exact same shape delivered
over SSE -- so `isValidNarrationEvent` (exported from `frontend/src/api/events.ts`)
recovers real `NarrationEvent` objects straight out of history, deduped against the live
tail by `phase`+`message` (the same composite key `JobEventPersistenceService`'s own
backfill sweep already uses). `mergedNarrations` replaces the raw `narrations` array
everywhere it fed the UI (`JobLifecycleSteps`, `NarrationTicker`, `ProgressBanner`'s
activity log) -- fixing not just the activity-log list but also "what phase is currently
active" showing stale/null immediately after a reconnect, before the first live event
arrives. The `FigureDescriptions` panel got the same treatment via a dedicated effect
backfilling `figureCaptionsByIndex` from historical `describe_figure` entries -- directly
closing the concretely-observed 39→20 regression, not just the general activity-log gap.
`/event-history`'s query itself stays unbounded, as recommended -- no pagination added
preemptively.

**Files:** `frontend/src/pages/JobDetail.tsx` (event-history effect, `mergedNarrations`,
figure-caption backfill effect), `frontend/src/api/events.ts` (`isValidNarrationEvent`
exported).

---

## 5. Narration text uses implementation jargon an ADO-savvy-but-not-req2ado-savvy engineer won't map to "how much is done"

**Status: OPEN — low priority, largely subsumed by #2**

Phrases like "Extracting a deterministic hierarchy subtree (1 of 1 --
Heading hierarchy -- synthesizing requirement text for 150 node(s))" are
accurate but internal — "deterministic hierarchy subtree" describes an
implementation strategy, not a user-facing concept. Once #2 ships, most
of these lines will carry a real percentage alongside the text, which
substantially reduces how much the raw wording matters (a number is
legible regardless of jargon). Not fixing the wording itself in this pass
— re-evaluate after #2 is live for a few real jobs; if it's still
confusing, it's a copy-only change with no logic risk.

---

## What's already good (confirmed, not just assumed)

- Real-time updates are WebSocket-pushed, not polled — confirmed via
  network trace (zero new HTTP requests over 15s of continued visible
  progress).
- "Time since last progress update from the server" heartbeat + a visible
  running elapsed timer — lets an engineer distinguish "still working" from
  "connection dropped," which a bare spinner alone would not.
- "You can close this page and come back — the run keeps going
  server-side" — directly addresses the long-running-job anxiety this
  review was asked to focus on.
- The existing progress-percentage design (`ProgressBanner.tsx`) has an
  explicit, documented "never fabricate a percentage" philosophy and
  already has real per-phase weighting (`PHASE_START_WEIGHT`) and a
  distinct honest message for phases with no fixed step count
  (`isTailPhase`) instead of faking a number — issue #2 above is a data
  wiring gap in two call sites, not a design flaw in this mechanism.
- Zero console errors/warnings observed on the job detail page itself.
- Cancel-run control exists and is reachable at all times during a run.
