# Content Significance Filtering — Design

Date: 2026-08-13
Status: Approved, pending implementation plan

## Problem

The app's core job is turning a customer requirements document (ICD or
similar, any supported format) into a well-defined Epic/Feature/Requirement
work-item tree. Two related gaps in SURVEY mode undermine "well-defined":

**A. Boilerplate sections can become spurious work items.** An
Introduction, Table of Contents, or Revision History section gets zero
different treatment than a real requirements section today — nothing
stops the model from inventing an Epic/Feature/Requirement out of pure
front matter.

**B. Figure noise dilutes node text.** Live E2E validation of SURVEY mode
against a real public document (NASA LVC Gateway ICD, 35 pages, uploaded
through the actual UI) surfaced this concretely: the document had 30
embedded figures, and only 2 had genuine informational content (a
revision/signature sheet, an alert-level table). The other 28 were
decorative placeholders, logos, and colored bars — the vision model's own
real output for most of them was some variant of "The image displays a
simple, rectangular, solid-colored block with no visible internal
components, labels, or connecting elements." Every one of these 28
non-answers still gets threaded into the LLM prompt that builds the
work-item hierarchy, as noise inside whatever node's text claims that
figure.

Neither is a new bug in the fidelity work merged earlier today — both are
pre-existing gaps in SURVEY mode's content-selection path that the live
test happened to expose for the first time with a real, messy document.

Note on (B)'s actual failure mode, confirmed by research: a figure never
becomes its own spurious work item — `WorkItemType` only ever has three
values (Epic/Feature/Requirement), and a figure's caption is only ever
folded as supporting text into whatever node's `figure_ids` claims it
(`ingestion/app/leveling/tree_builder.py:202-243`). So the real damage is
wording quality — a Requirement's text gets diluted with a decorative
logo's description — not phantom nodes.

## Root cause A: no boilerplate signal reaches the model at all

`section_analysis.v1.txt` (the SURVEY prompt) gives the model a real,
detailed Epic/Feature/Requirement scope rubric (an INVEST-style test:
"could this span multiple sprints and cover several Features? → Epic.
Delivers one coherent piece of user value made of testable Requirements?
→ Feature. One testable obligation? → Requirement." — `section_analysis.v1.txt:9-19`),
but contains **zero** instruction about front matter, revision history,
TOC, or boilerplate legal text — confirmed absent by direct inspection.

This isn't for lack of a deterministic signal to hang it on. Branch
boundaries are already 100% deterministic — `_split_into_branches`
(`tree_builder.py:19-43`) splits purely on the document's own resolved
heading depth, with no LLM involvement, and `_build_document_outline`
(`llm_leveling.py:658-677`) already produces a numbered list mapping every
branch to its heading label *before* any LLM call runs:
```
1. 1 Introduction
2. 2 System Overview
3. 3 Interface Requirements
```
The codebase already has a working precedent for classifying a branch by
its heading text deterministically: `_GLOSSARY_HEADING_PATTERN`
(`llm_leveling.py:680`, `re.compile(r"(?i)\b(definition|acronym|glossary|abbreviation|terminolog)")`),
used to special-case glossary sections. Nothing analogous exists for front
matter.

## Root cause B: the existing insignificance signal doesn't reliably fire

The vision prompt (`ingestion/app/vision/orchestrator_vision_client.py:16-21`)
already asks the model to signal "no technical content" with an exact
sentinel word:

```
Describe this figure or diagram in one or two sentences, focusing on any
technical content (components, connections, values, labeled parts). If the
image contains no discernible technical content, respond with exactly the
single word NO_TECHNICAL_CONTENT and nothing else.
```

And downstream code already knows what to do when that sentinel appears —
`llm_leveling.py:2477` substring-checks for `NO_TECHNICAL_CONTENT_SENTINEL`
before folding a figure's caption into section text, and
`tree_builder.py:202-218`'s `_figure_line` already omits a block entirely
when its caption is `None`/`"none"`. The mechanism for "don't show the
model an insignificant figure" already exists.

What doesn't exist: reliability. Vision models are bad at obeying
"respond with exactly this one word and nothing else" — confirmed live:
of 28 genuinely content-free figures in the LVC test document, the model
produced full descriptive prose for all of them, and only one even
approached the intended signal in free text ("this figure has no
discernible technical content" — not the literal sentinel, so the
substring check never matches). The sentinel convention is the right
*idea*, implemented in a way real models don't reliably comply with.

Separately: the vision prompt carries zero document-level context today
(`ingestion/app/main.py:677`, `_describe_figure_with_progress(image_bytes:
bytes) -> str` — image bytes only). A figure that's genuinely relevant to
*this* document's subject can't be judged as such without knowing what the
document is about.

## Chosen approach: two independent mechanisms

These solve different problems and use different tools deliberately — (A)
is a pure text-classification problem with a cheap deterministic answer
already available; (B) genuinely requires looking at image content, which
text keyword-matching cannot do.

### A. Deterministic front-matter guard (no LLM cost, no primer involved)

Add `_FRONT_MATTER_HEADING_PATTERN`, a keyword regex mirroring
`_GLOSSARY_HEADING_PATTERN`'s exact established shape (case-insensitive,
word-boundary, same file/neighborhood in `llm_leveling.py`):
`introduction|table of contents|revision history|document history|appendix|references?\b`
(exact keyword list finalized during implementation against real
documents already in `tests/fixtures/` — the pattern shape, not the
literal list, is the load-bearing decision here).

Run this against each branch's heading label — already available from
`_build_document_outline`'s own per-branch label lookup
(`_branch_heading_labels`), before any LLM call. On a match, inject an
explicit instruction into that branch's `kb_context` (via
`_combine_global_context`, the same injection point the glossary and
primer context already use): *"This section's heading matches typical
front-matter (Introduction/Table of Contents/Revision History/Appendix).
Only emit work items if genuine testable/actionable content exists in
this section's text — do not fabricate an Epic/Feature/Requirement merely
to represent this section's existence."*

This does **not** skip the LLM call or discard the branch — a real
requirement occasionally buried inside an Introduction must still surface.
It only adds the missing negative signal the prompt currently lacks,
using the same deterministic, zero-added-cost mechanism the glossary
special-case already proved out.

### B. Structured, primer-informed figure significance (LLM judgment, image content)

`orchestrator/src/modules/llm/openwebui.client.ts`'s `vision()` gains the
same `responseSchema` option `chat()` already has (`llm-client.interface.ts:52`,
`{name, schema}` → OpenAI-compat `response_format: json_schema`). This
mirrors the exact pattern `analyze_section` already uses successfully in
production (`ingestion/app/survey/orchestrator_llm_client.py:1600-1621`):
schema-constrained sampling, plus the same defensive parse/repair fallback
this codebase already relies on for LLM JSON output (`json_repair`).

The vision prompt is restructured to request:

```json
{ "significant": boolean, "description": string }
```

`describe_figure` (ingestion side) sets the Figure's `caption` to `None`
when `significant: false`, instead of storing whatever free-text the model
produced. This is the only change needed on the "is this figure worth
showing the model" question — everything downstream (`_figure_line`,
`llm_leveling.py`'s fold logic) already treats `caption=None` as "omit",
unchanged.

The old sentinel convention (`NO_TECHNICAL_CONTENT_SENTINEL`, the
substring check at `llm_leveling.py:2477`, the display-copy branch in
`main.py:706`) is retired — dead code once the boolean field exists. The
two existing tests that exercise it
(`test_describe_figure_still_caches_the_real_no_technical_content_sentinel`,
`test_build_survey_tree_skips_a_figure_the_vision_model_flagged_as_no_content`)
get replaced with equivalents against the new boolean field.

**Whole-document context reaches the vision prompt.** The vision prompt is
enriched with document-level context (title/subject) so "is this figure
significant" can mean "significant *to this document*," not just "does
this look technical in isolation." This reuses the exact mechanism Phase 6
(the whole-document AI context primer, merged earlier today) already
built: upload the raw file to Open WebUI, one chat completion with
`files: [{type: 'file', id}]` in "Using Entire Document" mode (confirmed
via Open WebUI's own docs: this mode "injects the full file content into
every message," bypassing RAG chunk-retrieval — a real, documented
toggle, not an assumption). No new upload/attach code — the same
`uploadFile`/`pollFileProcessed`/`chat()` call Phase 6 already added to
`openwebui.client.ts`.

**What moves:** today, `pipeline.worker.ts` computes `primerContext` after
`/ingest` returns, gated on the parsed document's estimated text length
(`estimateDocumentTextChars(doc)` — deliberately built to fix a prior bug
where raw byte size is a bad proxy for a PDF's real text content, since
PDF size is dominated by fonts/images). Figures, however, are described
*during* `/ingest` (parsing) — before that gate can run. Reusing the
primer for figure context means computing it *before* `/ingest`.

**The gate is dropped, not replaced with a pre-parse substitute.** Per
explicit direction: don't reinvent a client-side size heuristic for this
call (page-count, raw-byte-count, or otherwise) — lean on Open WebUI's own
file handling. The primer is now *always attempted* for every SURVEY-mode
job, with a fixed, generous `numCtx` (not computed from parsed document
length, since that isn't available pre-parse). Any failure — including a
context-overflow error Open WebUI might surface for an unusually large
document, which its docs don't specify behavior for — fails open to
`primerContext: undefined`, identical to every other optional capability
in this codebase (`llm_leveling.py`'s own `*_context: ... | None = None`
convention). This is an accepted, explicit tradeoff: a document too large
for the fixed `numCtx` silently loses figure-context enrichment (and the
whole-document primer for `/level`) rather than failing the job.

The same `primerContext` value is computed once and reused for both figure
description and the existing `/level` call — not recomputed twice.

**`/ingest` carries `primerContext` through to figure description.** New
optional request param on `POST /ingest`. Threaded to
`_describe_figure_with_progress`/`_describe_figure`
(`ingestion/app/main.py:677,288`) as a new `document_context: str | None`
parameter, included in the vision prompt sent to `describe_figure`
(`orchestrator_vision_client.py`).

### Table/figure attribution: already adequate, no change needed

Confirmed by research: for anything the model actually sees (captioned
figures, all tables), attribution to a specific node is already the
model's own choice, validated against a per-branch set of real ids
(`llm_leveling.py:2235-2253`) — hallucinated ids get dropped with an
`INVALID_FIGURE_IDS`/`INVALID_TABLE_IDS` warning. This mechanism is sound
and out of scope for this design. The only attribution weakness is the
positional fallback for *uncaptioned* figures (never shown to the model at
all, so it can't choose) — mechanism B above reduces how often that path
is hit by making captions more reliable, but the positional fallback
itself is unchanged.

## Data flow

```
0. orchestrator: job.mode === 'survey'
   -> uploadFile(job.fileBuffer) -> pollFileProcessed -> chat(
        "Using Entire Document" mode, fixed generous numCtx
      ) -> primerContext | undefined (fail-open on any error)

1. POST /ingest(file, mode, primerContext)
   -> per figure: describe_figure(image_bytes, mime_type, primerContext)
        -> vision() with responseSchema {significant, description}
        -> caption = significant ? description : None
   -> doc { figures: [...], blocks: [...], ... }  (unchanged shape otherwise)

2. POST /level(doc, ..., primerContext)   -- same primerContext, reused
   -> build_survey_tree(doc, ..., primer_context=primerContext)
        -> _build_document_outline gives branch -> heading label (existing, deterministic)
        -> _FRONT_MATTER_HEADING_PATTERN match on heading label (new, deterministic)
             -> matched: inject front-matter guard instruction into that branch's kb_context
        -> analyze_section(...) per branch (unchanged call shape)
```

## Error handling

- Primer upload/poll/chat failure at any step: `console.error` with job-id
  context (matching the existing primer fail-open logging added earlier
  today), `primerContext = undefined`, job proceeds exactly as if the
  primer were never attempted.
- `vision()`'s schema-constrained call failing/rejected (400/422): same
  schema-rejection retry `chat()` already has
  (`isSchemaRejection`, `openwebui.client.ts:20-22,116-121}`) — retry once
  without the schema. If the schema-less retry also fails, or returns
  unparseable content, `describe_figure` falls back to today's behavior:
  treat as non-significant (`caption = None`) rather than surfacing a raw
  parse error into a work item — a bad figure description must never fail
  the whole job.
- Front-matter guard injection never removes or truncates a branch's
  actual text — it only adds one extra sentence to `kb_context`, so a
  failure to detect (a false negative) degrades to today's exact behavior,
  and a false positive (a real-content section whose heading happens to
  match) still lets the model emit real nodes if genuine content is
  present — the instruction says "only emit if genuine content exists,"
  not "never emit."
- No change to `/level`'s existing fail-open behavior or the 1000-char
  clamp / `maxTokens: 300` guard already on the primer's chat call.

## Testing

- `test_llm_leveling.py`: new tests for `_FRONT_MATTER_HEADING_PATTERN`
  matching real heading labels ("1 Introduction", "Table of Contents",
  "Appendix A") and not matching real content headings ("3 Interface
  Requirements"); a branch whose heading matches gets the guard
  instruction appended to its `kb_context` via `_combine_global_context`;
  a non-matching branch's `kb_context` is unchanged (byte-identical to
  today).
- `openwebui.client.spec.ts`: `vision()` forwards `responseSchema` when
  provided, omits it when not (matches this file's own established
  forwards/omits convention); schema-rejection retry path reused/verified
  for `vision()` specifically.
- `orchestrator_vision_client.py` (ingestion): `describe_figure` returns
  `{significant, description}` parsed correctly; malformed/schema-rejected
  response falls back to non-significant, not an exception.
- `test_pdf_loader.py`/`test_llm_leveling.py`: replace the two
  sentinel-specific tests with equivalents against the boolean field —
  significant figure's caption reaches section text; non-significant
  figure's caption is `None` and omitted, with no dropped-block warning
  (matching the existing golden-path assertion these tests already make).
- `pipeline.worker.spec.ts`: primer call now fires unconditionally for
  `mode === 'survey'` (no more size-gate branch to test around) —
  existing size-gate tests get replaced with "always attempted, fails
  open" tests; primer computed before `/ingest` is called (call-order
  assertion); same `primerContext` value passed to both `/ingest` and
  `/level` (not recomputed).
- No new golden-fixture PDF/docx needed for mechanism B — it changes
  prompt construction and response shape, not document segmentation;
  existing fixtures already exercise figure blocks. Mechanism A may want
  one small real-shaped fixture with an "Introduction" section containing
  no testable content, to pin end-to-end that no spurious node is
  produced for it — finalized during plan-writing.

## Global Constraints

- Never log the file content or PAT/credentials in the primer's error
  path — job-id context only, matching existing convention.
- `responseSchema` addition to `vision()` must not change its existing
  callers' behavior when `responseSchema` is omitted (default parameter,
  backward compatible).
- Retired sentinel code (`NO_TECHNICAL_CONTENT_SENTINEL` and all its call
  sites) must be deleted, not left dead alongside the new boolean field.
- The front-matter guard must never fully suppress a branch or skip
  `analyze_section` — it only adds a soft instruction; a genuine
  requirement inside an Introduction section must still be able to
  surface as a real node.

## Explicitly out of scope

- No new client-side gating heuristic (byte-size, page-count, or
  otherwise) for whether to attempt the primer — deliberately dropped per
  the chosen approach above.
- No change to how `/level`'s own existing primer-consumption logic
  (`_combine_global_context`, `build_survey_tree`'s trailing
  `primer_context` param) works beyond adding the front-matter guard
  ingredient — *when* and *how often* the primer is computed changes, not
  the rest of how `/level` uses the value it's given.
- No deduplication/merging of near-identical decorative figures (e.g. the
  same logo repeated across pages) — each figure is still judged
  independently; only its significance verdict changes.
- No change to the existing table/figure attribution mechanism (LLM
  choice validated against a per-branch id set) — confirmed adequate,
  see "Table/figure attribution" above.
- No BASELINE-mode changes — both mechanisms are SURVEY-mode only, since
  BASELINE never calls `analyze_section` or the vision-significance path.
