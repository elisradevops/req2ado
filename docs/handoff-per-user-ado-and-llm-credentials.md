# Handoff — per-user ADO project + per-user Open WebUI credentials (2026-08-31)

Repo: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`, branch `main`
(work was done on `feat/per-user-ado-and-llm-credentials`, fast-forward merged
into `main` at the end of the session — see `git log 9f24808~1..8c144eb` for
the full range, or the commit list below).

**Status: fully done, tested, merged into `main`, and deployed to the local
docker-compose stack running on this machine.** Not pushed to `origin` — local
`main` was already 406 commits ahead of `origin/main` before this session
(pre-existing, unrelated to this work), so a push needs a separate, explicit
decision.

## Why this session happened

Two ASAP pre-production issues, reported directly by the user:

1. Open WebUI (LLM) access relied on a single shared, env-var-configured
   credential for every user — bad UX, wrong attribution, and a real
   prompt-hijack risk once presets were considered (see "Rejected" section of
   the original plan).
2. `ADO_PROJECT`/`ADO_BASE_URL`/`ADO_AREA_PATH` were server-wide env vars.
   Investigation found `ADO_BASE_URL` was dead code and `ADO_AREA_PATH` was
   already per-job, but `ADO_PROJECT` was a genuine half-finished migration:
   6 of 12 ADO operations read the per-job area path correctly, the other 6
   (including the **write path** — `ado_create_work_item`) silently fell back
   to a server-wide default project. A job could read from its own project
   and **write work items into a different one**, with reads looking correct,
   which is what made it dangerous.

Both expanded into a full per-user-credentials migration plan (Prerequisite +
Workstreams A/B/C) after investigation — see the original plan artifact,
`~/.claude/plans/docs-handoff-sweep-deferred-items-full-c-glimmering-candy.md`,
for the complete scoping/decisions record (LLM per-user = token + chat model +
vision model; base URL stays global; base-model-only picker filter; hard-fail
on missing config with a first-login gate; etc.).

## What was actually done, commit by commit

1. `9f24808` **Prerequisite** — `openWebUiAppRoot()`'s regex didn't strip an
   `/api/` prefix, silently breaking `uploadFile`/`chatWithFullFileContext`/
   the new `listSelectableModels` once `LLM_BASE_URL` moved to `.../api/v1`.
   Fixed, plus a missing `?process=true` on file uploads (confirmed via the
   real Open WebUI UI's own Network tab).
2. `fce89dc` + `6266ecf` **Workstream A** — `Job.adoProject`/
   `JobBatch.adoProject` columns (migration includes an area-path-derived
   backfill), threaded through all 12 ADO operations in `mcp-ado-server`
   (`realAdo.ts`'s `resolveProject()` helper), hard-fail on a null project at
   every write-path call site. This closes the actual "wrong project" bug.
3. `e1ba804` **Workstream B core** — `OpenWebUiClientFactory` (per-user,
   cached, keyed client) replaces the old process-lifetime singleton
   everywhere (`LlmController`, `LlmStatusController`, chat/jobs controllers,
   `DocumentOverviewService`, `pipeline.worker.ts`'s whole-document primer).
   New `LlmConnectionController` (validate-live-before-store, base-model-only
   catalog, never returns the token). New Settings "Open WebUI" row + dialog.
   `RouteGuard` first-login gate. Also fixed a model-mismatch bug this same
   migration would otherwise have introduced: an unset `job.model` now
   resolves to the submitting user's own default chat model, not a stale
   global one, so ingestion's caps-sizing can't drift from what actually ran.
4. `f667e3d` **B7** — retired `LLM_API_KEY`/`LLM_VISION_MODEL` as global env
   vars (confirmed dead once B core landed). `LLM_CHAT_MODEL` deliberately
   **kept**, narrowed to a documented fallback-of-last-resort (see
   `pipeline.worker.ts`'s `resolveDefaultChatModel` and `EtaService`'s pricing
   baseline) — not fully removable without either hard-failing a genuinely
   rare edge case or duplicating a hardcoded model name in code, and this was
   judged not worth it.
5. `b53c8c6` **B4 + Workstream C code** — a subagent threaded a per-call
   `user_id` through `OrchestratorLlmClient`/`OrchestratorVisionClient` (both
   module-level singletons in `ingestion/app/main.py`, so `user_id` had to be
   a pure per-call argument, never stored on `self` — verified with a
   `threading.Barrier`-forced-concurrency regression test). Two real gaps in
   that work were found and closed in the same commit: `/dedup/check` had no
   `user_id` field at all, and `/ingest`'s new `user_id` query param wasn't
   being sent by the orchestrator yet — both would have 401'd in production.
   Also implemented `openwebui.client.ts`'s `embedViaOpenAiProxy` (Workstream
   C's actual code: Open WebUI's deprecated-but-working `/openai/embeddings`
   proxy, since Ollama is confirmed permanently unavailable on production).
6. `badc91c` — documented the new `openai` embed transport option in
   `.env.template` (was implemented with zero docs).
7. `83d7d0d` **Independent review finding, Critical** — `OrchestratorEmbedClient`
   (ingestion's *sole* embedding client — dedup near-duplicate checks, KB
   retrieval/grounding, KB document ingestion, conflict detection,
   criteria-grounded quality scoring) was the one client commit 5 missed. It
   never sent `X-Req2Ado-User-Id`, so once the orchestrator's `/llm/embed`
   route started hard-requiring it, dedup/KB grounding would have silently
   degraded (both fail open on an embed exception) and KB ingestion would
   have hard-failed with 500s (an unguarded call site). Fixed: per-call
   `user_id` threaded through all 8 call sites; `CriteriaRetriever` (embeds a
   small static corpus once at construction) redesigned from a single
   process-lifetime singleton to a **per-user cache**
   (`main._get_criteria_retriever`), since the corpus embed itself now needs
   a real user's credential to run at all.
8. `5c3d7a7` **Live-testing bug #1** — `listSelectableModels()`'s
   vision-capability detection only checked `info.meta.capabilities.vision`
   (a boolean), which doesn't exist for Ollama-backed models. Confirmed live
   against the user's real production instance that this silently returned
   `vision:false` for every model, including two genuinely vision-capable
   ones. Ollama-backed models self-report via a plain string array under
   `ollama.capabilities` instead (e.g. `["vision","completion","tools"]`) —
   now checks both shapes.
9. `8c144eb` **Live-testing bug #2 + UX polish** — the Configure Open WebUI
   token field was being reset every dialog open, forcing a re-paste just to
   preview models while iterating. Now kept in memory only (never written to
   browser storage — deliberately **not** `sessionStorage`, matching this
   repo's own established rule against holding a raw secret client-side; see
   `authStore.ts`'s comment on why the ADO PAT was removed from
   `sessionStorage` for the same reason — user explicitly chose this option
   over the more literal "survive a refresh" ask). Also: the chat-model
   picker now marks vision-capable models with an eye icon + info tip instead
   of a `(vision-capable)` text suffix.

## The headline finding — worth remembering for future sessions in this repo

**A large, carefully-reviewed subagent task (commit 5, ~450k tokens, its own
concurrency regression test included) still missed one of three LLM client
classes needing the identical fix.** The independent review pass explicitly
asked to hunt for exactly this ("gaps where a currently-working feature would
silently start failing") caught it; self-review across two separate
implementation passes (mine and the subagent's) did not. This matches this
repo's own documented history from prior sweeps (see
`docs/handoff-sweep-deferred-items-full-closure.md`'s "headline finding") —
independent review is not optional overhead for credential/concurrency-shaped
work here, it has caught a real bug essentially every time it's been run.

Separately: two of the "bugs" chased down during live testing with the user
turned out **not** to be code bugs at all — the vision-capability field
mapping (real bug, fixed) surfaced alongside a second, superficially similar
symptom (`gemma4:26b`/`gemma4:e4b` showing no vision) that was root-caused,
via a WebFetch check against Ollama's own public model library page, to be an
**operational gap** (the locally pulled model copies are missing the
multimodal projector component) — not something any orchestrator-side code
change can fix. Worth remembering: not every "the UI shows something
surprising" report is a code bug — sometimes the code is correctly relaying
a real external-system state that needs an ops fix instead.

## Deferred / explicitly not done this session

- **Workstream C's actual rollout** — the code (`EMBED_TRANSPORT: 'openai'`
  branch) is implemented and tested, but the config flip
  (`EMBED_TRANSPORT=openai`, `EMBED_MODEL=OpenAI/text-embedding-3-large`) was
  deliberately **not** applied to any running config. Doing so invalidates
  every existing dedup/KB vector and requires the rollout procedure already
  documented in `docs/runbook.md`'s "Swapping EMBED_MODEL" section
  (re-backfill every area path, re-ingest every KB source, re-run the dedup
  threshold study against the new model's different geometry). This needs a
  scheduled window, not a silent deploy-time flip.
- **The `all-minilm`/`nomic-embed-text` calibration-baseline discrepancy**
  flagged in the original plan (two different files disagree on which model
  the existing 0.9416 dedup threshold figure was actually calibrated
  against) — not investigated or resolved. Should be resolved *before*
  trusting any new threshold number from the Workstream C rollout above.
- **`gemma4:26b`/`gemma4:e4b` vision capability** — flagged to the user as an
  operational gap, not fixed. Needs `ollama pull gemma4:26b` /
  `ollama pull gemma4:e4b` (and possibly an Ollama server version check) on
  their real infrastructure, outside this repo's/session's reach.
- **Independent review was run once**, over commits `e1ba804..b53c8c6`
  (Workstream B core + B4 + Workstream C code). It was **not** re-run over
  the two live-testing bugfixes (`5c3d7a7`, `8c144eb`) or the embed-client
  fix itself (`83d7d0d`) — those landed after the review and were verified by
  test suite + live testing with the user instead. Worth a second review pass
  if this area sees more changes before shipping further.

## Current live state (as of session end)

Full docker-compose stack (`orchestrator`, `pipeline-worker`, `frontend`,
`ingestion`, `mcp-ado-server`, plus `postgres`/`redis`/`chroma`) was rebuilt
from `main` at `8c144eb` and is running. The Prisma migration
(`20260831120000_add_job_ado_project`, including its backfill) is applied.
8 stale/orphaned test-fixture Redis keys (`job-events:*:narration-log` for
job ids with no matching Postgres row — pre-existing leftover test data, not
caused by this session) were found and deleted; `JobEventPersistenceService`'s
startup backfill no longer errors.

## Stray untracked files — not from this session, not triaged

`git status` on this repo shows a number of untracked files under
`docs/handoff-sweep-high-tier-sections-2-3-4-6-7.md` and
`docs/superpowers/plans/2026-08-3{0,1}-sweep-*.md`. These predate this
session (left behind by a different, unrelated effort referenced by a
since-discarded background task notification early in this session — see the
session transcript around the start if the provenance matters). They were
deliberately left alone and are **not** part of, or addressed by, this
session's work. Worth a look before they're mistaken for something this
branch was supposed to close.
