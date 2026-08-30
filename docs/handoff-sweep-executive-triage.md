# Handoff — pre-release sweep, Executive Triage blockers (2026-08-30)

Repo: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`, branch `ui-glowup-phase1-foundation`.
Complements `SWEEP.md` (the living, checklist-format tracker for the full 10-category audit) — this
doc is the narrative record of *why* each of the 8 Executive Triage blockers was real and *how* each
was actually fixed, for anyone who wasn't in the session. `SWEEP.md` itself has the up-to-date
checkbox state; treat it as the source of truth if the two ever disagree.

## Context: how this sweep happened

A full end-to-end pre-release audit was run across all four services (`frontend/`, `orchestrator/`,
`ingestion/`, `mcp-ado-server/`) via 9 parallel Opus-model investigation passes, one per concern area
(dead code/duplication, cross-file-type consistency, KB-usage verification, file-summary/UI-consistency
data-gathering, prompt determinism/cost/canaries, correctness bug sweep, Big-O complexity, React/
CLAUDE.md rules compliance, partial-tree ADO-approval semantics). Findings were consolidated into
`SWEEP.md`, organized by the user's original 10 categories plus a curated **Executive Triage** section
of the 8 findings that actually threatened data integrity or correctness in production — everything
else in `SWEEP.md` is real but non-blocking. This doc covers only those 8; the rest are still open,
tracked findings for future sessions.

Commits: `4b58ffb` (an unrelated section-label fix from earlier the same session, folded in as a
separate atomic commit — see its own message) and `0e39acc` (all 8 blockers, one commit — see below
for why they were bundled rather than split further).

## The 8 blockers

### 1 & 2 — `confirm()` could create or orphan duplicate ADO work items

**Found:** two independent races in `JobsService.confirm()` (`orchestrator/src/modules/pipeline/jobs.service.ts`),
both capable of producing duplicate or orphaned work items in a customer's real Azure DevOps project —
the single most damaging failure class this audit could have found.

**Race 1 — non-atomic status guard.** `confirm()` used `findUnique` (read `job.status`, check it's
`'diff_ready'`) followed by a separate `update({ status: 'writing' })`. Two concurrent callers — two
browser tabs, a client-side timeout-then-retry (confirm can legitimately run for minutes on a large
document), or an automation script calling the API twice — could both pass the read-check before
either wrote `'writing'`. Both then built an identical `toCreate` set from the same `dryRunDiff` and
both wrote every item to ADO. Nothing in the existing test suite exercised this because the fake-Prisma
mocks used in `jobs.service.spec.ts` don't model real Postgres row-locking semantics — the bug was only
visible by reading the code, not by any failing test.

**Race 2 — write-before-record ordering.** For each created item, the original order was:
`createWorkItem()` → `idempotencyService.record()` (a bare `prisma.create` against the
`@@unique([sourceHash, areaPath])` constraint) → `createdItemMapping.upsert()`. If `record()` threw —
which it would on exactly the kind of concurrent-resubmit scenario Race 1 also covers, since a
`resubmit()` deliberately preserves `sourceHash` (see `jobs.service.ts:288-317`) — the real ADO item
already existed, but no `CreatedItemMapping` row was ever written for it. The confirm-retry path relies
entirely on that mapping table to recognize "this local diff entry already has a real ADO item, skip
it" — with no such row, every future retry recreated the same item again, unbounded.

**Fix.**
- `confirm()`'s guard is now a single atomic `prisma.job.updateMany({ where: { id, status: 'diff_ready' },
  data: { status: 'writing' } })`. Postgres evaluates the `where` clause as part of the one `UPDATE`
  statement, so only the first caller can ever see `count: 1`; every other concurrent caller sees
  `count: 0` and throws the same "not in a confirmable state" error it always would have for a genuinely
  stale job.
- The create-loop was reordered so `createdItemMapping.upsert()` runs immediately after
  `createWorkItem()`, *before* `idempotencyService.record()`. `record()` itself was changed from
  `prisma.create` to `prisma.idempotencyMapping.upsert()` keyed on the compound
  `{sourceHash, areaPath}` unique — so even in the residual race window, a second caller's `record()`
  call updates the existing row instead of throwing, and the mapping table is now guaranteed to reflect
  reality regardless of ordering.

**A real environment issue surfaced while fixing this, unrelated to the bug itself:** the orchestrator's
generated Prisma client (`node_modules/.pnpm/@prisma+client@.../.../\.prisma/client`) was stale — it
still reflected an old 3-field `(sourceHash, customerId, areaPath)` unique constraint that
`schema.prisma` had already dropped in favor of the 2-field `(sourceHash, areaPath)` shown in the
schema file. This wasn't introduced by today's work; it was a pre-existing drift between the checked-in
schema and the generated (gitignored) client. Fixed with a plain `npx prisma generate` — no schema or
migration change.

**Verification.** All 93 inline fake-Prisma mock objects in `jobs.service.spec.ts` needed a stub
`updateMany` method added (previously they only mocked `findUnique`/`update`) — done mechanically with
one `perl` substitution matching the existing `job: {` block-opener pattern, verified by exact
occurrence-count and a clean `git diff` afterward. Full suite result: **186/186 passing.**

*(Aside for whoever reads the session transcript: this file's test run was initially, repeatedly
misread as "hanging for 10+ minutes" during the session. That was a tooling artifact — piping jest's
output through `tail` without `-f` means nothing prints until EOF, and this file happens to trigger a
separate, pre-existing "Jest did not exit one second after the test run has completed" open-handle
warning that keeps the process alive well past when its real results already printed, so the `tail`
pipe's EOF never arrived within any reasonable wait. Redirecting straight to a file instead revealed
the true ~1.2s runtime immediately. Not a real hang, not related to this fix.)*

### 3 — `retryWithBackoff` retried non-idempotent creates on lost responses

**Found:** `mcp-ado-server/src/backends/retryWithBackoff.ts` treats any dispatched HTTP request with no
received response (a timeout, `ECONNRESET`, or a 502/503/504) as unconditionally retryable, and
`createWorkItem()`/`uploadAttachment()`'s upload step both wrap their POST calls in this helper with
`maxRetries: 5`. The failure mode: ADO can commit a work-item create or an attachment upload
server-side and then lose the response on the way back (a flaky on-prem network is explicitly
mentioned in this module's own existing comments as the reason the no-response case was made retryable
at all, for GET/PATCH calls). For a POST create, a lost-response retry doesn't re-check anything — it
just issues the create again, and since the resulting duplicate never reaches
`CreatedItemMapping`/`IdempotencyMapping` (those are only written after the *first*, now-orphaned
response would have returned), req2ado has no record of the duplicate at all. Up to 6 copies of the
same work item (or attachment) could be created from a single confirm, silently.

**Fix.** Added an opt-out flag, `retryOnNoResponse` (default `true`, so every existing call site's
behavior is byte-for-byte unchanged), threaded through `isRetryable()`. `createWorkItem()` and the
upload half of `uploadAttachment()` now pass `retryOnNoResponse: false` — the only two non-idempotent
POSTs in the module. A real HTTP response status (429/5xx/409) still retries exactly as before under
this flag; it only changes behavior for the ambiguous "no response arrived at all" case.

**Verification.** `retryWithBackoff.test.ts` gained 3 new tests (does-not-retry on a bare `.request`,
does-not-retry on `ECONNRESET`, still-retries a real 503 even with the flag set) — 15/15 passing.
`realAdo.test.ts` unaffected, 46/46 passing.

### 4 — A failed dedup-judge silently dropped real requirements

**Found:** `ingestion/app/dedup/check_for_duplicates.py`'s `DuplicateJudgeClient` is an optional,
narrower LLM check that only ever runs *after* the cheaper embedding-similarity check has already
flagged a candidate as `is_duplicate = True` — its job is to catch the embedding model's known
false-positive class (two topically-adjacent-but-scopally-distinct short phrases). The original
exception handler for a judge call failure was `except Exception: judge_verdict = None` — silently
leaving `is_duplicate` at its pre-judge value of `True`, with **no warning logged anywhere**. Every
other fail-open path in this codebase (scoring, KB retrieval, conflict detection) explicitly appends an
`IntegrityWarning` and/or logs when it degrades; this was the one exception, and it degrades in the
*unsafe* direction — a judge outage doesn't just mean "less verification," it means every borderline
embedding match becomes a confirmed `dedup_skip`, and `confirm()` never creates those diff entries at
all (`jobs.service.ts`'s create-loop explicitly filters out `dedup_skip` actions). The UI, meanwhile,
shows the user a confident "near-duplicate of WI-N" badge with no indication the judge never actually
ran to confirm it. A real requirement can vanish from the diff with zero visible signal that anything
went wrong.

**Fix.** The exception handler now logs
`logger.warning("Dedup judge call failed, embedding verdict (is_duplicate=%s) stands unverified: %s", ...)`
and sets `judge_verdict = "judge_failed"` — a new value, distinct from `None` (which still means "the
judge never ran at all, e.g. no client configured"). `is_duplicate` itself is left unchanged (the
embedding's own verdict still stands, matching every other fail-open convention in this module of
"degrade to the next-most-trusted signal, don't invent a worse one") — the fix is about making the
degradation *visible and distinguishable*, not about changing what happens when it occurs.

**Verification.** The existing regression test (`test_judge_client_exception_falls_back_to_the_embedding_only_verdict`)
was renamed and extended (`..._but_is_marked_unverified`) to assert both the new verdict value and that
a warning was actually logged (`caplog.at_level("WARNING")`). 18/18 passing.

### 5 — Supported document-format set disagreed across the stack

**Found:** three different "which file extensions are OK" lists exist, and two of them silently
diverged. `ingestion/app/dispatch.py`'s `_SUPPORTED_EXTENSIONS` (used by both the job-ingestion path
and the KB-ingestion path) covers 8 document types plus 8 image types. `orchestrator/src/modules/pipeline/jobs.controller.ts`'s
`ALLOWED_EXTENSIONS` — the gate that runs *before* a job upload ever reaches ingestion — covers only 5
(`.txt .md .docx .pdf .xlsx`), and both frontend dropzones match that narrower 5-item list. The
orchestrator constant's own comment claimed it "matches ingestion's actually-implemented loaders" —
false; `.pptx`, `.csv`, `.rtf`, and every image type are real, tested, working ingestion loaders that a
job upload can never reach because the orchestrator's pre-check silently 400s them first, while the
identical file types work fine through the separate KB-upload endpoint. A future engineer trusting that
stale comment could plausibly try to "fix" the mismatch by deleting real, working format support instead
of recognizing it as an intentional (if under-documented) product boundary.

**Fix — deliberately scoped down from what the audit's raw finding might suggest.** Rather than
changing which formats jobs can be created from (a real product-scope decision — several of the
under-supported formats have their own, separately-tracked bugs elsewhere in `SWEEP.md`'s item 3 that
would need fixing first if job creation were widened to them), this fix addresses only the actual
Blocker: the stale, misleading documentation, plus a guarantee that it can't silently drift further.
`jobs.controller.ts`'s comment on `ALLOWED_EXTENSIONS` now correctly describes it as a *deliberate
subset* of ingestion's fuller format set, and a new test,
`orchestrator/test/allowed-extensions.drift-guard.spec.ts`, parses `dispatch.py`'s real
`_SUPPORTED_EXTENSIONS`/`_IMAGE_EXTENSIONS` Python set literals directly out of the source file and
asserts every orchestrator-allowed extension is still present in ingestion's fuller set — so if
ingestion ever drops support for one of the 5 job-creation formats (or someone tries to widen
`ALLOWED_EXTENSIONS` past what ingestion can actually parse) without updating both sides, this test
fails immediately instead of surfacing as a live 400 in production.

**Verification.** New drift-guard test, 1/1 passing.

### 6 — BASELINE mode collapsed multi-sheet `.xlsx` workbooks into one ADO item

**Found:** `ingestion/app/loaders/xlsx_loader.py` gave every sheet's `Table.source_ref` the literal,
hardcoded `SourceRef(start_offset=0, end_offset=0)` — identical for every sheet in the workbook.
`tree_builder._hash_identity` (the function that computes `WorkItemNode.identity_hash`, which
BASELINE's ADO idempotency lookup keys on) hashes only `document_path + start_offset + end_offset` —
`description` is deliberately excluded from that hash (a separate, already-fixed bug from an earlier
session: including description made the hash unstable for LLM-generated content, and was redundant for
BASELINE's byte-verbatim content anyway). The practical consequence: every sheet in a multi-sheet
workbook produced the *exact same* identity hash, so `IdempotencyService.lookup()` resolved sheets 2
through N to sheet 1's already-created ADO work item — a customer uploading a 10-sheet requirements
workbook in BASELINE mode would only ever get sheet 1's content written to ADO, with every other sheet
silently treated as "already exists, skip."

**Fix.** Each sheet's `SourceRef` now gets `start_offset=sheet_index, end_offset=sheet_index + 1` — the
exact same "running offset counter, one slot per table" convention `pptx_loader.py` already uses for
tables embedded in a slide, for the identical reason (giving each table instance a genuinely distinct
identity rather than a collision-prone `(0, 0)`).

**Explicitly not fixed alongside this** (flagged, not silently ignored): `pdf_loader.py` has the same
root shape for a different reason — its per-page block-offset counter resets to `0` at the start of
every page (`offset = 0` inside the per-page loop, `pdf_loader.py:1825`), so the *first* table on any
given page can collide in identity with the first table on any other page. This sits inside a much
larger, more delicate per-page content-merge pipeline (multi-column detection, figure interleaving,
paragraph/table/image ordering) than the isolated one-line xlsx fix, and is real but Medium severity —
left in `SWEEP.md`'s item 3 backlog rather than risking a rushed change to that pipeline under today's
time constraints.

**Verification.** New test in `test_xlsx_loader.py` asserts no two sheets in the existing 2-sheet
`sample.xlsx` fixture share a `(start_offset, end_offset)` pair — 13/13 passing. Full ingestion suite:
1633/1634 (the 1 failure, `test_ingest_survey_mode_still_captions_when_vision_is_configured`, was
confirmed pre-existing and unrelated via `git stash` — it fails identically on the unmodified branch).

### 7 — No LLM call anywhere set a sampling seed

**Found:** the user's explicit ask (item 6/7 of the original sweep request) was for maximally
deterministic LLM output. Auditing every chat call site turned up a structural gap: `orchestrator/src/modules/llm/openwebui.client.ts`'s
`chat()` method already knew how to forward a `seed` into the Ollama-compatible request payload — but
nothing upstream of it ever supplied one. The wire-level DTO,
`orchestrator/src/modules/llm/llm-chat.dto.ts`, had no `seed` field in its Zod schema at all, so even if
ingestion's Python client *had* sent one, it would have been silently stripped by the schema parse
before ever reaching the controller. `temperature: 0` alone — which most call sites in this codebase
already set — does not guarantee run-to-run determinism under llama.cpp/Ollama (batch-size and
KV-cache-dependent floating-point nondeterminism, plus tie-breaking behavior, are both independent of
temperature).

**Fix, end to end:**
- `llm-chat.dto.ts` gained `seed: z.number().int().optional()`.
- `llm.controller.ts` forwards it in both the non-streaming `chat()` handler and the streaming
  `chatStream()` handler.
- `openwebui.client.ts`'s `streamChat()` method (used only by the interactive per-node chat feature,
  `/llm/chat/stream` — never by the core SURVEY pipeline, which exclusively uses the non-streaming
  `/llm/chat` proxy) previously forwarded *no* sampling options at all beyond `model`/`temperature`/
  `responseSchema`/`maxTokens`; it now also forwards `seed`. (It still doesn't forward `numCtx`/`topK`/
  `minP`/`think` — that's a separately-tracked, non-blocker gap in `SWEEP.md` item 6, left alone today
  since the streaming chat path isn't part of the SURVEY pipeline's determinism story at all.)
- `ingestion/app/survey/orchestrator_llm_client.py`'s `OrchestratorLlmClient.__init__` gained a `seed`
  parameter that **defaults to `42`** — a deliberate asymmetry with `num_ctx`/`top_k`/`min_p`, which
  stay `None`-by-default/opt-in per construction site (they have genuine cost/tuning tradeoffs — a
  larger context window costs more, `top_k`/`min_p` are a specific model's repetition-bug mitigation).
  Seed has no such tradeoff, so rather than requiring each of the 5 places in `main.py` that construct
  this client to individually remember to pass one, the constructor itself makes determinism the
  default and lets a caller opt *out* with an explicit `seed=None` if that's ever genuinely wanted (no
  such caller exists today). The seed is spread into all 19 live chat-payload call sites in this class —
  mechanically, right alongside each site's existing `numCtx` spread, via a `perl` substitution
  (verified by exact occurrence-count matching before/after) — and one call site with a differently-
  indented payload dict that the mechanical pass missed was caught and fixed by hand.
- `ingestion/app/survey/llm_cache.py`'s `cache_key()` gained a `seed` parameter, so a cached response
  from one seed can never be replayed as a hit for a differently-seeded call under the old key shape.

**Deliberately not touched today** (both real, both tracked separately in `SWEEP.md` item 6): the two
module-level singleton LLM clients in `main.py` (`_dedup_judge_client`, `_checklist_client`) still
construct with no model override and no `numCtx` — they now get `seed=42` automatically (since that's
the new constructor default regardless of which call site builds the client), but their model/context
sizing remains unmanaged. And the `topK`/`minP` coverage gap (5 of 19 payloads, vs. seed's now-19-of-19)
stays as-is — the natural next step is a `_sampling_options()` helper that would let a single change
apply to all four options at once, rather than four separate mechanical passes over the same 19 call
sites.

**Verification.** Orchestrator: `llm-chat.dto.spec.ts` + `llm.controller.spec.ts` +
`openwebui.client.spec.ts`, 122/122 combined (6 new tests: DTO accept/reject, controller forwarding for
both `chat`/`chatStream`, client forwarding for `streamChat`). Ingestion: `test_llm_cache.py` +
`test_orchestrator_llm_client.py`, 193/193 (existing `cache_key()` tests updated for the new parameter
position; two call sites in `test_orchestrator_llm_client.py` that constructed cache keys with
positional args needed an explicit `None` inserted for the new `seed` slot to keep testing what they
originally tested, rather than accidentally shifting a `*parts` element into the new parameter).

### 8 — O(n²) pure-Python cosine-similarity scan in conflict detection

**Found:** `ingestion/app/leveling/conflict_detection.py`'s `_detect_conflicting_duplicates` clusters a
document's Requirement nodes into near-duplicate groups (feeding the separate LLM conflict-judgment
step) via all-pairs cosine similarity, computed by a pure-Python `_cosine_similarity()` call inside a
nested `for i / for j` loop. Two compounding problems: the O(n²) *pair count* is inherent to "compare
every node to every other node" and can't be avoided, but the *arithmetic itself* was needlessly
expensive — `_cosine_similarity` recomputes both input vectors' norms on every single pair, even though
`blend_embeddings` (the function that produces every vector reaching this loop) already renormalizes
its output to unit length, meaning that recomputed norm is provably always `1.0`. At a real-world scale
of ~500 Requirements in one document, this was measured (via the audit, not directly re-benchmarked in
this session) at minutes of single-threaded interpreter time inside a single job — pure waste, since the
actual comparison is a handful of floating-point multiplies that any vectorized numeric library handles
in microseconds.

**Fix.** Replaced the per-pair loop with a single vectorized similarity-matrix computation: stack all
embeddings into one `(n, d)` numpy array, normalize each row once, and compute the full pairwise
similarity matrix as one matrix multiplication (`normalized @ normalized.T`). A zero-norm guard was
added to exactly match `_cosine_similarity`'s own existing `norm_a == 0 or norm_b == 0 → 0.0`
short-circuit (defensive; no real embedding has been observed to be a zero vector, but the old function
handled it and the new one must too, to avoid a divide-by-zero producing `NaN` similarities instead).
The remaining Python-level loop (union-find bookkeeping over the now-precomputed matrix) is unchanged —
it was never the expensive part. `_cosine_similarity()` itself was left completely untouched; it's
still directly imported and used elsewhere (`app/quality/criteria_retrieval.py`) and still directly
unit-tested, so deleting or altering it would have been out of scope. `numpy` was already an installed
transitive dependency (via `chromadb`) but had never been imported directly anywhere in this codebase —
added as an explicit direct dependency in `ingestion/pyproject.toml` now that production code imports it.

**Verification.** All 9 existing tests for this function still pass unchanged. One new test was added —
30 synthetic Requirement nodes across 3 groups (10 + 15 + 5, with the 10- and 5-node groups sitting at
cosine 0.9 to each other, over the 0.85 threshold, and the 15-node group orthogonal to both) — asserting
the vectorized matrix produces the *identical* union-find clustering (one 15-node merged cluster, one
separate 15-node cluster) the old pairwise loop would have, not just for the pre-existing hand-picked
2-node test cases but at a scale where a real indexing mistake (a transposed axis, an off-by-one in the
upper-triangle loop) would visibly show up as wrong-group clustering. 10/10 passing.

*(One process note for whoever reads the transcript: this test was initially, accidentally merged with
the tail of the pre-existing adjacent test during authoring — a `Read` call's line-limit window ended
right at what looked like the end of the neighboring test function, when it actually continued 2 more
lines past that window. The Edit tool's exact-string match still succeeded because the 3-line substring
it was given to replace was real, present text — just not the *true* end of that function — so the new
test ended up swallowing the original function's last 2 assertions as its own trailing statements. Both
functions happened to use variables named `nodes`/`warnings`, so this ran without a `NameError` and only
surfaced as a semantically-wrong assertion failure. Caught immediately by running the tests before
moving on; fixed by restoring the original function's real tail and properly closing the new function
before it. Worth remembering: reading a suspiciously-round-numbered line window near a function boundary
is worth double-checking past the window's edge before trusting a "this is where the function ends"
assumption.)*

## Why these 8 were bundled into one commit (`0e39acc`)

They're independent bugs in independent code paths, and could in principle have been split into 8
separate commits. They were kept together because: (a) they were investigated and fixed as one
continuous unit of work in direct response to one consolidated audit deliverable (`SWEEP.md`'s Executive
Triage section), (b) none of them depend on or conflict with each other at the code level, so splitting
would add commit-boundary overhead without adding any real reviewability, and (c) the earlier,
genuinely-unrelated section-label fix that happened to be sitting in the same working tree *was* split
out into its own commit (`4b58ffb`) specifically because it was a different piece of work from a
different part of the session, which is the actual dividing line this session used for "what counts as
one commit's worth of change."

## What's next

See `SWEEP.md` directly — it's the living tracker. As of this doc, its own "Notes for whoever picks
this up next" section calls out, in priority order:

1. Item 4's KB-grounding blocker (`llm_leveling.py:2946` — always-include KB files get cited as
   grounding but never actually reach the scoring/authoring prompt on the default tool-capable model
   path) — investigated in the same audit, explicitly *not* bundled into today's fix pass, and the
   natural next Blocker to pick up. Small, isolated, one-line merge fix per its own `SWEEP.md` entry.
2. The `_sampling_options()` / `_chat_json()` refactor (items 2 + 6/7) — today's seed fix already
   touched all 19 relevant call sites once; the next pass extending `topK`/`minP` coverage will touch
   the identical lines again unless the helper refactor happens first.
3. Item 5 (a real, computed-but-never-shown "did the AI understand this document" data inventory) needs
   an actual `/design` session before any implementation — nothing there has been built yet.
4. Everything else in `SWEEP.md` outside the Executive Triage section is still exactly as originally
   investigated: read-only, unfixed, severity-tagged, ready to be picked up in any order by category.
