# Figure-Significance Filtering — Design

Date: 2026-08-13
Status: Approved, pending implementation plan

## Problem

Live E2E validation of SURVEY mode against a real public document (NASA
LVC Gateway ICD, 35 pages, uploaded through the actual UI) surfaced a real
quality gap: the document had 30 embedded figures, and only 2 had genuine
informational content (a revision/signature sheet, an alert-level table).
The other 28 were decorative placeholders, logos, and colored bars — the
vision model's own real output for most of them was some variant of "The
image displays a simple, rectangular, solid-colored block with no visible
internal components, labels, or connecting elements." Every one of these
28 non-answers still gets threaded into the LLM prompt that builds the
work-item hierarchy, as noise.

This isn't a new bug in the fidelity work merged earlier today — it's a
pre-existing gap in SURVEY mode's figure-handling path that the live test
happened to expose for the first time with a real, messy document.

## Root cause: the existing insignificance signal doesn't reliably fire

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

## Chosen approach

Three changes, together:

### 1. Structured significance output, not a hoped-for sentinel

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

### 2. Whole-document context reaches the vision prompt

The vision prompt is enriched with document-level context (title/subject)
so "is this figure significant" can mean "significant *to this document*,"
not just "does this look technical in isolation."

This reuses the exact mechanism Phase 6 (the whole-document AI context
primer, merged earlier today) already built: upload the raw file to Open
WebUI, one chat completion with `files: [{type: 'file', id}]` in "Using
Entire Document" mode (confirmed via Open WebUI's own docs: this mode
"injects the full file content into every message," bypassing RAG
chunk-retrieval — a real, documented toggle, not an assumption). No new
upload/attach code — the same `uploadFile`/`pollFileProcessed`/`chat()`
call Phase 6 already added to `openwebui.client.ts`.

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

### 3. `/ingest` carries `primerContext` through to figure description

New optional request param on `POST /ingest`. Threaded to
`_describe_figure_with_progress`/`_describe_figure`
(`ingestion/app/main.py:677,288`) as a new `document_context: str | None`
parameter, included in the vision prompt sent to `describe_figure`
(`orchestrator_vision_client.py`).

## Data flow

```
1. orchestrator: job.mode === 'survey'
   -> uploadFile(job.fileBuffer) -> pollFileProcessed -> chat(
        "Using Entire Document" mode, fixed generous numCtx
      ) -> primerContext | undefined (fail-open on any error)

2. POST /ingest(file, mode, primerContext)
   -> per figure: describe_figure(image_bytes, mime_type, primerContext)
        -> vision() with responseSchema {significant, description}
        -> caption = significant ? description : None
   -> doc { figures: [...], blocks: [...], ... }  (unchanged shape otherwise)

3. POST /level(doc, ..., primerContext)   -- same primerContext, reused
   -> build_survey_tree(doc, ..., primer_context=primerContext)
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
- No change to `/level`'s existing fail-open behavior or the 1000-char
  clamp / `maxTokens: 300` guard already on the primer's chat call.

## Testing

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
- No new golden-fixture PDF/docx needed — this changes prompt construction
  and response shape, not document segmentation; existing fixtures already
  exercise figure blocks.

## Global Constraints

- Never log the file content or PAT/credentials in the primer's error
  path — job-id context only, matching existing convention.
- `responseSchema` addition to `vision()` must not change its existing
  callers' behavior when `responseSchema` is omitted (default parameter,
  backward compatible).
- Retired sentinel code (`NO_TECHNICAL_CONTENT_SENTINEL` and all its call
  sites) must be deleted, not left dead alongside the new boolean field.

## Explicitly out of scope

- No new client-side gating heuristic (byte-size, page-count, or
  otherwise) for whether to attempt the primer — deliberately dropped per
  the chosen approach above.
- No change to how `/level`'s own existing primer-consumption logic
  (`_combine_global_context`, `build_survey_tree`'s trailing
  `primer_context` param) works — only *when* and *how often* the primer
  is computed changes, not how `/level` uses the value it's given.
- No deduplication/merging of near-identical decorative figures (e.g. the
  same logo repeated across pages) — each figure is still judged
  independently; only its significance verdict changes.
