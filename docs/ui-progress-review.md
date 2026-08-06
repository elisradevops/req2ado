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

**Status: DEFERRED — needs a design decision, not a safe surgical fix**

Every chunked pass (title/tag enhancement, leaf synthesis, parent
summarization, scoring) does `warnings.append(message)` on a **local
Python list** when an individual chunk's LLM call fails — this list is
only ever persisted to the `Job.warnings` column when the whole tree
build finishes. It is never pushed through `progress_callback`/the
narration WebSocket. For a short document this is invisible for seconds;
for a 500+ page, multi-hour SURVEY run, a chunk that silently degrades at
hour 1 gives the engineer zero live signal — they find out only when the
job finishes hours later, at which point re-running to fix it costs
another multi-hour cycle.

**Why deferred, not fixed now:** this needs an actual design decision
(a new narration phase/severity level? a distinct "Warnings (N)" live
counter next to Activity log? do we want a toast, or just a badge?), not
just wiring two existing fields — the "surgical, minimal fix" bar this
review otherwise held to doesn't apply cleanly here. Flagging with a
concrete recommendation: fire a `progress_callback` alongside every
`warnings.append(...)` in the chunked loops, with a `severity: "warning"`
narration phase, and give `ProgressBanner.tsx` a live "N warning(s) so
far" counter (not just the final post-completion `job.warnings` list).

**Files (for the eventual fix):** `ingestion/app/leveling/id_tree_builder.py`,
`ingestion/app/leveling/scoring.py`, `ingestion/app/leveling/narration_publisher.py`,
`frontend/src/components/ProgressBanner.tsx`

---

## 4. Activity log keeps only the last 50 events, both server- and client-side

**Status: DEFERRED — needs a retention/UX decision**

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

**Recommendation (unchanged in spirit, sharper now):** let a **running**
job's reconnect hydrate from the same durable `/event-history` source a
terminal job already uses, instead of relying solely on the bounded live
replay. Keep the 50-event **live tail** for "what's happening right now";
add a real "View full history" (or just widen the mid-run hydration path)
backed by the Postgres store that already, correctly, has everything.

**Files (for the eventual fix):** `frontend/src/pages/JobDetail.tsx`
(the `status === 'running'` early-return on the event-history effect),
`orchestrator/src/modules/pipeline/job-events.controller.ts` (already
correct/unbounded — the gap is purely in when the frontend calls it)

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
