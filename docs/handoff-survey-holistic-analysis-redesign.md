# Handoff — SURVEY holistic-analysis redesign (Phase 1 done, Phase 2 remaining)

Repo: `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado` (the real repo — **no
worktree**, work directly on a branch here per the user's explicit standing instruction: never
create/enter/operate inside a git worktree for any task).

Branch: `survey-holistic-analysis-redesign-v2`, currently checked out. `main` is exactly **1
commit behind** this branch (clean fast-forward relationship — `git merge-base main
survey-holistic-analysis-redesign-v2` resolves to `main`'s own tip, `689e95d`). The single commit
ahead is `48d7ec0` — a large (173 files, 21016+/1194-) reconciliation commit landing this session's
SURVEY redesign work plus a whole backlog of prior work that had accumulated on this branch's
lineage but never made it onto `main`'s separate, previously-unrelated history (see "How this
branch came to exist" below for the full story — important context, not just trivia).

**Full design doc (read this first, it is the source of truth for the redesign itself):**
`/Users/EdenZviSchwartz/.claude/plans/lets-plan-how-to-sprightly-deer.md` — lives in the user's
Claude Code plans directory on their machine, NOT inside this repo. If unavailable in a fresh
environment, ask the user for it before starting; this handoff is a summary, not a replacement.

## Immediate next step: land this branch on `main`

`main` is exactly 1 commit behind (`48d7ec0`), pure fast-forward, no divergence, no merge needed:

```
git checkout main
git merge --ff-only survey-holistic-analysis-redesign-v2
```

Do this FIRST in a fresh session before starting new work, unless the user says otherwise —
right now all of this work only exists on the feature branch.

## How this branch came to exist (important context, not skippable)

This session's actual task was narrow: implement the SURVEY holistic-analysis redesign (see below).
That work was done on a worktree at `.claude/worktrees/req2ado-phase10`, itself checked out on a
branch (`merge-req2ado-main-full`) that turned out to have **NO common git ancestor** with this
repo's real `main` — two genuinely independent histories (confirmed via `git merge-base`, which
returned nothing). That branch was itself the product of an earlier, separate reconciliation
project (tasks #20–28 in the task list: "Setup," "Phase 0–7... full verification") merging in yet
another unrelated lineage (`req2ado-standalone-history`).

When asked to get this session's work onto `main`, two automated approaches were tried and BOTH
were found to **silently drop real content** without any error:
- `git apply --3way` — silently deleted an entire orchestrator route (`vision()` in
  `llm.controller.ts`) while reporting only an unrelated import line as conflicted.
- `git merge-file` (real diff3) — same failure mode on the same file, for a structural reason: with
  no common ancestor, the tool has no valid 3-way base to reason from at all.

The only reliable method that emerged: hand-compare every file's FULL content on both sides (`git
show <mine>:<path>` vs. the file as it exists on `main`) rather than trusting any diff/merge tool's
output. This surfaced that the real scope wasn't the ~46 files this session touched — it was
**~173 files**, because `main`'s independent lineage was also missing entire features from earlier
in this session's history that had simply never been reconciled: k8s manifests, the backfill
service, vision/quality-criteria modules, structured KB citations, the ADO project-picker, and more.
Every file was verified as a strict superset (nothing unique to `main` was lost) before being
carried over. Full verification: **420 ingestion (pytest) + 291 orchestrator unit (jest) + 80
mcp-ado-server (vitest) + 110 frontend (vitest) — 901 tests, all green** on the reconciled tree.
Orchestrator's 4 e2e specs need live Postgres/Redis wired to matching ports/env — not exercised in
that pass, not a sign of a real defect.

**Lesson for future work on this repo**: if `main` and whatever branch you're on ever diverge again
with no common ancestor, do NOT trust `git apply --3way` or `git merge-file`'s conflict reporting at
face value — both have been directly observed to silently drop content while reporting success.
Full-content comparison is the only verified-reliable method found so far.

## The actual SURVEY redesign work (this session's real deliverable, ~14 files within the 173)

### Why this redesign exists (one paragraph — see the plan file's §1 for full detail)

SURVEY mode (customer-document → Epic/Feature/Requirement ADO tree) was mechanically atomizing
structure: every input `Block` became exactly one outline line, one hierarchy node, one requirement
— via two sequential calls (`infer_hierarchy` then `generate_requirements_for_document`). On a real
customer docx this produced garbage: bullet/spec lists exploded into one fake "requirement" per
line, a literal `"[FIGURE: none]"` placeholder (vision was off by default) became a fabricated
100/100-scored requirement, and Word tables were silently dropped entirely (SURVEY never referenced
`doc.tables`). The fix: replace the two-call 1:1 mechanical pipeline with ONE holistic per-section
LLM call (`analyze_section`/`analyze_section_agentic`) that returns however many nodes the section
actually contains, given one coherent structure-preserving rendering of the section instead of a
shredded outline. Agentic KB retrieval (a `query_kb` tool call during analysis) was added mid-session
per explicit user direction, superseding an earlier once-per-document pre-computed KB design (which
survives only as the fallback path for non-tool-capable models).

### What's DONE and live-verified

- **Vision activation** — `LLM_VISION_MODEL=gemma4:e4b` was set in the `.env` used during
  development (the worktree's copy, gitignored — **this repo's own `.env` at this path currently has
  `LLM_VISION_MODEL=` EMPTY, confirmed just now** — you must set it again here before vision
  captioning will actually activate). Live-verified against the real
  `AirPro_BP_ICD_Revision_0.3.docx` (path: `~/Downloads/AirPro_BP_ICD_Revision_0.3.docx` on the
  developer's machine — NOT in the repo, ask the user if it's needed again): 33/36 figures (92%)
  got real captions. Two real bugs found+fixed along the way:
  - `ingestion/app/loaders/docx_loader.py` — `describe_figure` failures were silently swallowed with
    zero logging; added `logger.warning(..., exc_info=True)`.
  - `orchestrator/src/main.ts` — Express's default 100kb JSON body limit was rejecting most
    `/llm/vision` calls with `413`; raised to 10mb via `app.useBodyParser('json', { limit: '10mb' })`
    on `NestExpressApplication`.
  - Remaining 3/36 failures are `.emf` legacy vector images — Ollama's vision endpoint `500`s on
    these. Real, distinct, out-of-scope format limitation (would need an EMF→raster conversion step,
    e.g. via LibreOffice headless — not attempted).
  - **Live-confirmed model capabilities** via Ollama's own `/api/show` `capabilities` field
    (important — corrects an early assumption): `qwen3:4b` → `['completion','tools','thinking']`
    (tools yes, vision no). `gemma4:e4b` → `['completion','vision','audio','tools','thinking']`
    (BOTH). There is currently no locally-available model that lacks tool support, so the §5c
    non-tool-capable fallback path (pre-computed once-per-document KB) has **not** been
    live-exercised — only unit/synthetic-tested. Verify it with an unknown-model-name case or find a
    genuinely non-tool-capable local model if you want a live check.

- **Orchestrator tool-calling passthrough** (plan §5a) — `llm-chat.dto.ts` (Zod, widened schema to
  accept `tool`/`assistant-with-tool_calls` messages, added `tools`/`toolChoice`),
  `llm-client.interface.ts` (`LlmChatResult` replacing bare-`string` `chat()` return — `content`
  stays present so this is backward-compatible; the only direct in-process TS caller,
  `llm.controller.ts`, was updated), `openwebui.client.ts` (forwards `tools`/`tool_choice`, returns
  `toolCalls`/`finishReason`), `redactor.ts` (`ChatMessage` widened with optional
  `content`/`tool_calls`/`tool_call_id`, `redactMessages` guards the now-optional `content`).
  Live-verified end-to-end: forced a real `tool_calls` round-trip through `qwen3:4b` via
  `curl localhost:3001/llm/chat` with a `tools` array — correct function name + arguments came back.

- **Section-analysis schema + client** (plan §2a/§2b/§5b) —
  `ingestion/app/survey/_response_schemas.py`: `section_analysis_schema()`, object-wrapped
  `{"nodes":[...]}` with **no `maxItems`** — this is load-bearing, read the file's own header
  docstring before touching it: a `maxItems`-bounded top-level array schema compiles to Ollama's
  expensive bounded-repetition GBNF grammar regardless of actual output size, and wedged a real job's
  whole Ollama server for 10+ minutes earlier this session (job `c7c654c2...`).
  `ingestion/app/survey/orchestrator_llm_client.py`: `analyze_section` (single-shot,
  `responseSchema`-constrained, fallback path) and `analyze_section_agentic` (bounded
  `_MAX_TOOL_ROUNDS=4` tool-calling loop, exposes `QUERY_KB_TOOL`, takes an injected
  `retrieve_fn: Callable[[str], tuple[str|None, list[dict]]]` so the client stays free of KB/Chroma
  dependencies — the CALLER is responsible for closing `retrieve_fn` over
  `area_path`/`embed_client`/`vector_store`). Deliberately ships **without** `responseSchema` on the
  agentic path (`tools`+`responseSchema` combination flagged as provider-specific/unverified) —
  live-tested and works cleanly schema-less, so this has NOT been re-tested WITH both together.
  `SectionAnalysisClient` Protocol added to `ingestion/app/leveling/llm_leveling.py`. Both methods
  live-verified end-to-end against real `qwen3:4b`: a spec-list bullet run (voltage/current/connector
  under one intro line) correctly folded into ONE coherent requirement instead of one node per bullet
  — direct proof the core fragmentation bug is fixed by this design. The agentic loop called
  `query_kb` with a sensible synthesized query and its final requirement genuinely incorporated
  content that existed ONLY in the fake KB snippet handed back by the test's `retrieve_fn` stub, not
  in the original section text — proof of real tool-driven grounding, not decoration.

- **`render_section`** (plan §3) — added to `llm_leveling.py`, replacing `_build_outline` **but
  `_build_outline` has NOT been deleted yet** and nothing calls `render_section` yet —
  `_build_survey_tree_for_branch` still calls the old `_build_outline` + `infer_hierarchy` +
  `generate_requirements_for_document` pipeline. Wiring `render_section`/`analyze_section`/
  `analyze_section_agentic` into `_build_survey_tree_for_branch` is the very next task (§2c/§5c/§6
  below) — until that lands, SURVEY mode's actual runtime behavior is UNCHANGED; only new, unused
  code paths exist so far. Verified in isolation: headings render as markdown headers,
  `[FIGURE: none]` is omitted entirely, real captions render as `"> Figure: ..."` lines, blank table
  rows are skipped, tables render as valid markdown pipe tables (currently appended at the section's
  end — real document-order placement is a later item, not yet done).

## What's REMAINING (Phase 2 — not started, in priority/dependency order)

Cross-reference the plan file's own section numbers for full design detail — do not re-derive
designs from scratch, they are already worked out including flagged judgment calls needing sign-off.

1. **§2c/§5c/§6 — Rewrite `_build_survey_tree_for_branch` + capability gate + `_resolve_caps`.** The
   big one; everything above is inert until this lands.
   - Replace the two-call body with a call through the §5c capability gate: tool-capable model →
     `analysis_client.analyze_section_agentic(section_text, retrieve_fn)`; otherwise →
     `analysis_client.analyze_section(section_text, kb_context=kb_context)`.
   - `_resolve_caps(model)` replacing the fixed `_MAX_SURVEY_BRANCH_BLOCK_COUNT` constant — returns
     `(branch_cap, supports_tools)` per model. Use these live-confirmed values: `qwen3:4b` →
     `(200, True)`, `gemma4:e4b` → `(200, True)` (both tool-capable — correct an earlier plan draft
     that assumed `gemma4:e4b` lacked tools).
   - `temp_id`-keyed node mapping replacing `node_id`-keyed 1:1 block mapping; dangling
     `parent_temp_id` falls back to root + warning.
   - Accepted trade-off to preserve, not silently regress: `source_ref`/`grounding_score` become
     branch-level/coarser (no more 1:1 block↔node mapping to compute them precisely against) —
     document this in the function's docstring.
   - Coverage/completeness warnings re-expressed via the existing
     `_block_content_appears_in_generated_output` helper (already used elsewhere in this file)
     instead of 1:1 node_id accounting.
2. **§4 — xlsx-only-document synthetic branch fix.** `load_xlsx` returns `blocks=[]`,
   `tables=[...]` → today's block-driven `_split_into_branches` yields an empty tree for any
   xlsx-only upload (confirmed real gap). Early-exit in `build_survey_tree` when `doc.blocks` is
   empty and `doc.tables` is non-empty, producing one synthetic branch.
3. **§11 — Narration phase consolidation.** `narration_publisher.py`'s `Phase` literal currently has
   separate `infer_hierarchy`/`generate_requirements` phases from the old two-call design — collapse
   to one `analyze_section` phase once §2c lands (do this AFTER §2c, not before).
4. **§12/§13 — Loader document-order tables/figures + PDF bbox de-dup.** Give tables a real
   document-order position (python-docx body-element walk in `docx_loader.py`, bbox-based ordering
   in `pdf_loader.py`) so `render_section` can interleave them inline instead of appending at section
   end. Also fixes PDF's duplicate table-leak (`page.extract_text()` currently re-captures
   table-cell text `extract_tables()` already got). Moderate size, real golden-fixture blast radius
   (BASELINE mode shares these loaders — its golden fixtures need re-verification too even though its
   own logic is untouched).
5. **§14/§15 — Referenced-attachment detection + agentic fetch tools.** Tier 1 (regex scan for
   "ReqID"/"see excel"/"attached" → warnings) is cheap, do it. Tier 2 (`read_kb_document`/
   `fetch_referenced_item` agentic tools) — KB-resolution is cheap (reuses the §5b loop + a new
   `KbVectorStore.get_document()`); ADO-resolution is flagged in the plan as the single LARGEST
   remaining item (ingestion has no ADO/MCP access today — would need a new
   ingestion→orchestrator→MCP route). Confirm scope with the user before starting Tier 2
   ADO-resolution specifically.
6. **§16 (task #41) — Exempt bearer-guarded LLM routes from `ThrottlerGuard`.** Already logged
   before this redesign; now more urgent since the agentic loop's `query_kb` can fire several
   `/llm/embed` calls per branch. Small (`@SkipThrottle()` or equivalent).
7. **Test rewrite (Python)** — `FakeLlmLevelingClient`/`FakeBatchedRequirementClient` in
   `ingestion/tests/test_llm_leveling.py` need replacing with a `FakeSectionAnalysisClient` once
   §2c's call site changes; add tests for `analyze_section_agentic`'s loop/bound, `_resolve_caps`
   gating, the xlsx synthetic branch, dangling-parent fallback. Re-baseline golden fixtures after
   §12/§13's loader changes land.
8. **Live end-to-end re-verification** against the real `AirPro_BP_ICD.docx` once §2c lands: confirm
   no node text contains `"[FIGURE: ...]"`, bullet runs fold into coherent requirements (already
   proven at the `analyze_section` unit level — confirm it holds through the full branch/tree
   pipeline), tables appear as real folded-in requirements, an xlsx-only test doc produces a
   non-empty tree, KB citations reflect what the model actually pulled via `query_kb`.

## Gotchas a fresh session must know before touching this code

- **This repo does not use worktrees.** Work directly on a branch in
  `/Users/EdenZviSchwartz/Repos/Projects/elisradevops/req2ado`. The user's global CLAUDE.md now has
  a standing rule forbidding worktree creation/entry entirely — added mid-session after a worktree
  ended up holding this whole reconciliation's work and had to be manually torn down.
- **Never re-add a `maxItems`-bounded top-level array `responseSchema`** to any SURVEY LLM call
  without first re-verifying the GBNF grammar-cost cliff against whatever Ollama version is running
  — see `_response_schemas.py`'s own header docstring, it is the canonical record of this finding.
- **`.env`'s `LLM_VISION_MODEL` is EMPTY in this repo right now** (confirmed at handoff time) — it
  was set to `gemma4:e4b` in a different, gitignored `.env` copy during development and that setting
  did not carry over. Set it again here if vision work continues; it's a one-line env change, no
  code change needed (the wiring is already real and complete).
- The AirPro test document lives outside the repo on the developer's machine
  (`~/Downloads/AirPro_BP_ICD_Revision_0.3.docx`) — ask the user for it (or an equivalent real
  customer document) rather than assuming it's available.
- Docker services (`orchestrator`, `ingestion`, `pipeline-worker`) need
  `docker compose up -d --build <service>` after any code change to that service before live-testing
  against them.
- `orchestrator`'s bare `npx tsc --noEmit` fails on unrelated `test/` rootDir config noise — use
  `npx nest build` (what CI/the real build actually uses) to typecheck, and `npx jest` to run tests.
  `npx jest --testPathIgnorePatterns="e2e-spec"` runs only the unit suite (291 passing, confirmed);
  the 4 e2e specs need live Postgres/Redis matching the env vars they set internally.
- If `better-sqlite3`'s native binding is missing (mcp-ado-server test failures citing
  `Cannot find module '.../better_sqlite3.node'`), `pnpm install` skips native build scripts by
  default (see the "Ignored build scripts" warning) — run
  `(cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run install)` to force
  the rebuild, or symlink `@types/express` similarly if TS complains it's missing from a package's
  own `node_modules/@types/` (both were needed once during this session's reconciliation pass; pnpm
  workspace hoisting can leave individual packages missing a transitive `@types/*` dependency their
  own `tsconfig` needs to resolve).
