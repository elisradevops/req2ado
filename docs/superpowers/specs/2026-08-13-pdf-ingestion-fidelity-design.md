# PDF Ingestion Fidelity — Design

Date: 2026-08-13
Status: Approved, pending implementation plan

## Problem

`ingestion/app/loaders/pdf_loader.py` never received the fidelity pass
`docx_loader.py` got (see `docs/superpowers/specs/2026-08-11-analyze-context-fidelity-design.md`).
Research against pdfplumber 0.11.10/pypdf 6.14.2 and six real public-domain
documents (NASA SOHO ICD, NASA LVC Gateway ICD, a CubeSat ICD, NASA Systems
Engineering Handbook, an IRS AcroForm, plus a synthetic reportlab fixture)
surfaced a root-cause bug that invalidates naive fixes, several downstream
consequences of that bug, and a security/architecture question in an early
proposal for a second, unrelated capability (a whole-document AI context
primer) that was resolved once the deployment's actual trust boundary was
confirmed (fully on-prem, `LLM_TRUSTED_LOCAL=true`). All of it — PDF loader
fixes, multi-column detection, and the AI context primer — is committed
work in this spec.

## Root cause: PDF text never gets segmented past one block per page

`pdf_loader.py:543`:

```python
paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
```

pdfplumber's `extract_text()` joins lines with a single `"\n"` and never
emits a blank line (confirmed against its own source,
`pdfplumber/utils/text.py`). `"\n\n"` therefore never occurs, and **every
page becomes exactly one `PARAGRAPH` block** — verified live against this
repo's own `tests/fixtures/sample.pdf`: `load_pdf(...)` returns a single
block per page containing the page's entire text, newline-joined. The
identical one-block-per-page shape exists in the OCR path
(`ocr.py:81-90`).

This is not cosmetic. `resolve_block_depth`/`parse_numbering` are anchored
at `^` and only ever see a page-block's *first line* — the rest becomes an
opaque "remainder" no downstream code looks at again. Consequences,
each verified by running the real functions against realistic page-blocks:

- **PDF branch splitting barely happens today.** A page whose first line
  is a running header (e.g. `"LVC ICD-03 - REV B"`, confirmed repeating on
  33/35 real pages of the LVC Gateway ICD) resolves to depth `None` — every
  such page falls out of `known_depths` entirely. A document where most
  pages open with a header falls through to `build_survey_tree`'s
  single-branch token-window fallback: PDFs get little to no real
  structural branching.
- **`_build_document_outline` (Task 10, already merged) is a no-op or
  actively harmful for PDF.** Header-first pages yield outline entries
  like `"1. (section 1)"` — zero information. Worse: when a page's first
  line genuinely is numbered, `_branch_heading_labels` returns
  `block.text` for that "heading" — which for a one-block-per-page
  document is the **entire page's text** — bloating the compact-outline
  contract `_build_document_outline` explicitly documents and stuffing it
  into every branch's `global_context`.
- **`_find_glossary_sections` (Task 11, already merged) cannot fire
  correctly for PDF.** In the normal case there's no real per-line label to
  keyword-match against, so it never fires. In the abnormal case — a page
  whose entire dumped text happens to contain "definition" or "acronym"
  anywhere — it fires **wrongly**, inlining an arbitrary page's full
  content into every other branch.

Two more real, independent bugs were found while verifying this:

- **`ocr.py:103`** constructs `CanonicalDoc(document=..., blocks=blocks,
  tables=text_doc.tables)` with no `figures=` argument. Every `.pdf` routes
  through `load_pdf_with_ocr_fallback` (`dispatch.py:78`), so any PDF with
  at least one non-text page silently loses every `Figure` object — the
  `FIGURE`-kind blocks survive in `blocks`, but `figure_id_by_block_id`
  resolves nothing against an empty `figures` list, breaking
  `node.figure_ids`/attachment linking with no error anywhere (`figures`
  defaults to `[]`).
- **`pdf_loader.py:580-594`** hardcodes `border_style="grid"` on every
  extracted table, with an explicit in-code note that this is only valid
  because the call site uses pdfplumber's default lines strategy. Adding
  text-strategy (borderless) table detection without revisiting this will
  fabricate ruled borders on every borderless table in the ADO output.

`tests/test_pdf_loader.py:20-25`'s existing assertions
(`len(doc.blocks) >= 1`, a substring check) pass identically under the bug
and under a correct fix — this is why the bug shipped unnoticed.

## Non-goals

- **Rotated pages.** Verified in pdfplumber's own source
  (`page.py`'s `_normalize_box`/`rotate_point`) that page rotation is
  already corrected internally before any bbox reaches a consumer. Not a
  gap; no task exists for it.
- **AcroForm field extraction as body content.** Scoped down to a
  fail-loud marker only (see Phase 4) — see rationale there.
- Any change to non-PDF loaders (except Phase 6's `build_survey_tree`
  threading, which is format-agnostic by design — see Phase 6).

This spec **reverses two non-goals** from the 2026-08-11 analyze-context-fidelity
design ("header/footer text extraction — low value," "any change to
PDF/RTF/OCR loaders beyond shared helpers") — that design's own rationale
("headers are metadata, not requirements") is still correct; it's the
argument for **suppressing** headers once they're a real, addressable
block, not for leaving segmentation broken so they can never become one.

## Phase 0: Real paragraph/line segmentation (blocks everything else)

**File:** `ingestion/app/loaders/pdf_loader.py` (the per-page text
extraction path, `~line 543` and its OCR counterpart in `ocr.py:81-90`)

Replace the dead `text.split("\n\n")` with real line-level segmentation:
pdfplumber's own line-clustering (`page.extract_text_lines()` or
equivalent word-to-line grouping already available via
`extract_words(extra_attrs=[...])` grouped by `top`) becomes the emission
unit, with adjacent same-style lines merged back into a paragraph run (no
font-size/style change, no vertical gap wider than the surrounding
line-height) so a single sentence wrapped across three lines still emits
as ONE `PARAGRAPH` block, not three.

This is a bug fix to the existing granularity contract, not new
capability — its own test must pin block *count* (not just `>= 1`) against
a real multi-line, multi-paragraph fixture, closing the exact gap that let
the original bug ship silently.

## Phase 1: Header/footer suppression (same phase as segmentation, not after)

**File:** `ingestion/app/loaders/pdf_loader.py`

Must land **together with** Phase 0, not after it. Verified concretely:
`parse_numbering("2 | P a ge")` → `("2", "| P a ge")` → depth 1. Once real
per-line blocks exist but before footers are suppressed, every page
footer becomes a **top-level branch boundary** — fixing segmentation alone
makes PDF branching *worse* than today's single-fallback-branch case, not
better.

Two independent detectors, since headers and footers behave differently
in practice (verified against the LVC Gateway ICD):

- **Header**: exact-text match at a consistent top-of-page position across
  a strong majority of pages (verified: `"LVC ICD-03 - REV B"` recurs
  verbatim on 33/35 pages).
- **Footer**: position-based, with digit-normalization before comparing —
  verified real footers vary only in an embedded page number
  (`"2 | P a ge"`, `"4 | P a ge"`, same template). Normalize digits to a
  placeholder before the recurrence check, not exact-string match.

A block classified as a running header/footer is dropped from the
emitted block stream entirely (not retained as a `NOTE` — this is
low-value, repeated boilerplate the 2026-08-11 spec already correctly
identified as non-requirement content; the reversal here is about
*detecting* it reliably, not about *keeping* it).

Also matters for Phase 2: repeated boilerplate is a strong small-font-size
outlier that will skew a font-size histogram if not removed first.

## Phase 2: Heading detection

**File:** `ingestion/app/loaders/pdf_loader.py`

Verified two real government ICDs use **incompatible** textual heading
conventions — LVC Gateway: `"1. Introduction"` (matches
`app.leveling.numbering.parse_numbering`); SOHO: `"SECTION 1. INTRODUCTION"`
(does not — `parse_numbering` is anchored to a leading digit). Text-pattern
matching cannot be the primary signal the way it effectively is for docx
(where style/`outlineLvl` is reliable); PDF carries no equivalent semantic
markup by default.

**Layered signal, not a single "primary" heuristic** — mirrors
`resolve_block_depth`'s own two-signal shape (`depth.py:13-18`) instead of
competing with it:

1. **Font-size/weight clustering decides *whether* a line is a heading** —
   real per-word `size`/`fontname` confirmed available via
   `extract_words(extra_attrs=['size','fontname'])`; a line whose font size
   is a clear outlier above the page's dominant body-text size (and,
   ideally, bold) is a heading candidate.
2. **`parse_numbering`/`numbering_depth`, when the heading's own text
   parses, decides *what depth*** — far more trustworthy than a size-rank
   guess when available (an explicit "3.2" beats inferring nesting from
   font size alone).
3. **Font-size cluster rank is the depth fallback** when the heading has no
   parseable number (covers the SOHO-style `"SECTION N. TITLE"` case and
   any bare, unnumbered heading).
4. **Outline/bookmarks (`pypdf.PdfReader.outline`) are a tier-0 override
   when present** — confirmed real API (`Destination.title`/`page`/`top`/
   `left`); confirmed real on the NASA Systems Engineering Handbook (41
   real entries) but absent on all 3 sampled ICDs. Off the critical path:
   match by text+position against an already-emitted block, and fall
   through to signals 1-3 on any match failure — never mis-anchor a
   heading to the wrong block on a failed match.

Populate `Block.number_label` for PDF headings using the same field
docx's heading-number synthesis (`fc16a9e`) already populates — without
it, PDF headings enter the outline stripped of their ordinal identity
("3.4.2") the same way unnumbered docx headings would without that fix.

**Watermark risk** (flagged, not yet mitigated in this phase): a watermark
can be the largest font on a page (this repo already ships
`tests/fixtures/watermarked_sample.pdf` for exactly this class of noise).
A font-size heading detector must exclude watermark-classified text
(reuse whatever future/existing watermark-confidence signal exists) before
ranking candidates — noted as a fixture/test requirement for this phase,
not a separate phase.

## Phase 3: Table fidelity

**File:** `ingestion/app/loaders/pdf_loader.py`

- **Cross-page table continuation**: `find_tables()` is per-page only.
  Verified a real case: SOHO ICD's "Table 3.4" ends on page 35 (row
  `01/3/Rejected - mnemonic...`) and continues on page 36 (row
  `01/4/Rejected - format error...`) — same column count, no repeated
  header row, two separate `Table` objects today. Merge condition must be
  stronger than "same column count" (would merge two unrelated same-shaped
  tables on consecutive pages): prior table's bottom edge sits in the
  page's bottom band, continuation's top edge sits in the next page's top
  band, AND column x-edges align (the loader already computes this edge
  set for column-width calculation — reuse it, don't recompute).
- **`Table.caption`**: never populated for PDF today (the field exists,
  nothing sets it). A `"Table N: <title>"` line immediately adjacent to a
  detected table is a real, deterministic, zero-cost signal — higher
  traceability value than several other items in this spec and should
  land in this phase.
- **Borderless (text-strategy) tables**: verified real ICDs have many more
  tables findable via `vertical_strategy='text'` than the current
  lines-only default (72 vs 43 on SOHO; 32 vs 5 on LVC Gateway) — but
  naive adoption is unsafe: verified live that text-strategy detection
  shreds ordinary prose into a garbled fake table (cells split mid-word,
  e.g. `"F"` / `"or some tests..."`). Tightening pdfplumber's own
  `min_words_horizontal`/`min_words_vertical` knobs does **not** fix this
  (tested). Required: a validation layer on top of raw text-strategy
  detection before accepting a candidate — reject a candidate if any cell
  boundary splits mid-word (a strong, checkable signal: a cell that starts
  with a lowercase letter immediately following where the previous cell
  ended is not a fabricated column, it's a chopped word) or if cell text
  looks like sentence fragments rather than short values. Must also fix
  the `border_style="grid"` hardcoding — a text-strategy-detected table is
  never `"grid"` (no ruling lines exist by construction); set it to
  `None`/appropriate per the strategy that actually found it.

## Phase 4: AcroForm fields (fail-loud only, lowest priority)

**File:** `ingestion/app/loaders/pdf_loader.py`

Verified live: a filled AcroForm field's value never appears in
`extract_text()` output at all; `pypdf.PdfReader.get_fields()` sees it
(confirmed against a real IRS SF-1199-A form, 71 real fields). Deprioritized
relative to the other phases: the target corpus (ICDs/specs) rarely
contains filled forms; `get_fields()` returns `None` (not `{}`) on a
document with no AcroForm at all (confirmed against this repo's own
fixture) and needs a guard; and a field's value has no natural position in
body reading order without also reading its `/Rect` (page-relative
placement), which this phase does not attempt.

**Scope**: one `BlockKind.NOTE` marker per page that has any filled
AcroForm fields, listing `field_name: value` pairs — matching the
docx-loader precedent for "flag, don't silently drop, and don't
over-engineer position for a rare case" (`altChunk`/OLE markers). Not
woven into body reading order.

## Phase 5: Multi-column detection

**File:** `ingestion/app/loaders/pdf_loader.py`

The x0-coordinate gap-clustering + per-column crop technique is verified
working on a synthetic 2-column fixture (correctly recovers
left-column-then-right-column reading order), but has zero validation
against a real document — 0 of 9 real public-domain documents sampled for
this spec turned out to be genuinely multi-column. A false-positive column
split is a real, worse-than-today failure mode: it interleaves unrelated
requirements' content into one block, rather than merely reordering words
within a still-recoverable line the way today's plain garbling does.

Given no real corpus exists to validate an automatic split against, this
phase ships the **conservative, flag-only** version, not automatic
splitting:

- Gate per-page, not per-document — a document can mix single- and
  multi-column pages.
- Require a clean vertical whitespace band spanning most of the page's
  text height with zero words crossing it (not just the largest x0 gap —
  a wide table column or a title page's label/value layout can produce a
  large gap with no real column boundary, both confirmed as real false
  candidates during this spec's research).
- Carve out full-width elements explicitly — a table or figure spanning
  the gutter x-range is not a column boundary and must not gate the
  page as multi-column.
- On a page that passes all three checks, emit a `BlockKind.NOTE` marker
  flagging it as suspected multi-column (page number + the detected gap
  band), rather than attempting an automatic split. Leave the page's
  existing (garbled) extraction in place alongside the marker — the flag
  is additive, not a replacement extraction path.

Automatic column-splitting (actually reflowing left-then-right into
correct reading order, not just flagging) is a natural second iteration
once real flagged pages accumulate into an actual validation corpus — not
built in this phase.

## Phase 6: Whole-document AI context primer

Read the whole document once, up front, to build richer "initial context"
than deterministic heuristics alone can produce, feeding every branch's
later analysis. The underlying need is real and already has a
deterministic precedent in this codebase
(`_find_glossary_sections`/`_combine_global_context`, Task 11) — this
phase is an AI-authored version of that same idea, format-agnostic (all
loaders, not PDF-specific), landing last so its measured value is judged
against the Phase 0-5 baseline, not today's broken one.

**Sequencing**: ship Phase 0+1 first and re-measure real documents before
building this phase. This spec's Phase 0 fix alone means PDF's
deterministic outline goes from `"1. (section 1)"` (today, real, verified)
to a correctly-numbered real heading list — for free, no LLM call, no new
failure surface. Building the primer against today's broken baseline
would inflate its apparent value and credit an LLM for what is actually a
data-pipeline bug fix.

**Shape:**

- **Raw file upload to Open WebUI is the mechanism.**
  `docs/architecture.md`'s locked "redact-first" decision exists as
  defense against egress to a third-party-hosted LLM backend. This system
  is not yet in production; confirmed the intended posture is Open WebUI
  running fully within the same trusted on-prem network as everything
  else (`LLM_TRUSTED_LOCAL=true` for this deployment specifically — the
  template/k8s-configmap default of `false` is a generic starting point,
  not this deployment's actual value). Under that trust boundary,
  `POST /api/v1/files/` + "Using Entire Document" mode is the mechanism.
  - Still required for hygiene, independent of trust boundary: explicitly
    `DELETE /api/v1/files/{id}` after the grounding chat completion
    returns, on every code path including error paths — Open WebUI does
    **not** auto-delete chat-attached files (confirmed: this is an open,
    unanswered question in Open WebUI's own community discussions), and
    "temporary" is an intended behavior req2ado must build, not a platform
    default.
  - Still required: poll `GET /api/v1/files/{id}/process/status` until
    `completed` before issuing the chat completion — a documented real
    race exists where the upload endpoint returns success while `content`
    stays empty. Treat `failed` or a timeout waiting for `completed` as a
    fail-open case (see below), never a blocking error.
- **Lives in the orchestrator, not `ingestion`.** `/level`'s request body
  is `CanonicalDoc` JSON only, no raw bytes; `/ingest` deletes its temp
  file in `finally`; there is no object storage in this system (raw bytes
  live in Postgres, held by the orchestrator's job worker). The natural
  home is wherever the orchestrator already holds the file and already
  talks to Open WebUI (`pipeline.worker.ts`/`openwebui.client.ts`) — run
  it there, pass the result into `/level` as a new, plain **string**
  parameter (`primer_context: str | None = None`), not a client object.
  `build_survey_tree` accepts and threads this string exactly like every
  other optional capability in that file: `None` = byte-identical to
  before the capability existed.
- **Narrow scope — not a second structure enumerator.** Do not ask the
  primer for section lists or glossary terms; the deterministic side
  produces those completely once Phase 0 lands, and this codebase has
  already documented long-document LLM enumeration as unreliable
  (`model_caps.py`'s `coverage_budget_tokens` rationale, lost-in-the-middle
  positional bias). An incomplete AI list sitting beside a complete
  deterministic one in the same prompt is worse than no AI list. Scope to
  what a heuristic genuinely cannot produce: document type/purpose, the
  system under specification, domain conventions, what "the unit"/"the
  system" refers to, requirement-phrasing style, intended readership — a
  short, capped addition to `global_context`, not a replacement for any
  of it.
- **Cache by content hash.** The primer runs in the orchestrator
  (TypeScript), not `ingestion` (Python) — `llm_cache.py`'s Redis-backed,
  fail-open, 24h-TTL cache (keyed on `(operation, model, num_ctx, top_k,
  min_p, *parts)`) is a different service's module and can't be called
  directly. Same *pattern*, orchestrator-side primitive: the orchestrator
  already holds a Redis connection for BullMQ — key a cache entry on
  `("primer", model, sha256)` off that same connection (or off
  `JobSourceFile`'s existing content hash in Postgres, if one already
  exists there) so re-runs and retries are free. Exact implementation is
  an orchestrator-side decision at plan time, not fixed here.
- **Gate on `fits_whole_document`, not document size.** Skip the primer
  when the whole-document-fits-in-one-call gate is already true (a single
  analysis call already sees the entire document; a primer adds latency
  for nothing) — matching glossary-inlining's own existing gate.
- **A positive `num_ctx` guard, not just fail-open-on-error.** Running the
  primer against local Ollama without an explicit `num_ctx` silently
  truncates to 2048 tokens and returns *plausible, confidently wrong* text
  describing only the first pages of a large document — this never
  triggers a fail-open error path, since nothing raised. Requires an
  explicit check (`num_ctx >= estimated_tokens`, skip and return `None`
  otherwise) before firing, not just a try/except around the call.

## Testing

- Phase 0's own test must pin block *count* against a real multi-line,
  multi-paragraph fixture (the exact gap that let the "\n\n" bug ship
  silently — `len(doc.blocks) >= 1` proves nothing).
- Real-excerpt fixtures from the documents already downloaded and verified
  during this design's research (all public-domain/US-Government works,
  freely redistributable): NASA SOHO ICD (SECTION-numbered headings,
  running-header-free page-splitting also worth a fixture, cross-page
  Table 3.4 continuation), NASA LVC Gateway ICD (digit-numbered headings,
  running header on 33/35 pages, digit-varying footer), NASA Systems
  Engineering Handbook (real outline/bookmarks, 41 entries), IRS SF-1199-A
  (real AcroForm, 71 fields), a CubeSat ICD (ruling-line pinout tables, a
  different real table style than the two ICDs above).
- Golden-fixture regression check required: Phase 0/1's segmentation and
  header/footer removal change per-block token counts, which can flip
  `fits_whole_document` for borderline documents and change which
  `build_survey_tree` code path fires. Run existing golden-fixture tests
  (`tests/test_survey_golden.py`-equivalent) against the real-excerpt
  fixtures above, not just the existing synthetic ones.
- Verify `docx_pagination.py`'s `load_pdf(text_only=True)` consumer
  (joins per-page block texts with `" "` in `_build_page_index`) against
  header/footer removal specifically — LibreOffice-converted docx-to-PDF
  carries the docx's own headers, so removal is likely a net alignment
  improvement, but must be verified rather than assumed; `docx_pagination`
  already has its own synthetic multi-block-page tests to extend, and
  `settings.docx_page_alignment_enabled` is the existing kill switch if a
  regression is found.
- Fix the two independently-found bugs (`ocr.py`'s missing `figures=`,
  `border_style="grid"` hardcoding) with their own regression tests,
  each landing in the phase that would otherwise be blocked by or newly
  expose them (OCR-figures fix stands alone; `border_style` fix lands in
  Phase 3 alongside text-strategy tables).
- Phase 5's flag-only detector needs both a positive fixture (a real
  vertical-whitespace-band page → one `NOTE` marker) and negative
  fixtures proving the two confirmed false-candidate shapes are excluded
  (a wide table column, a title-page label/value layout) — a test that
  only exercises the positive case would pass a detector that's still
  wrong on the exact cases already found to be dangerous.
- Phase 6 is orchestrator-side (TypeScript) — its tests belong with
  `openwebui.client.spec.ts`'s existing conventions, not `ingestion`'s
  pytest suite: mock the upload/status/chat-completion HTTP calls, and
  explicitly test every fail-open path (upload failure, `failed` status,
  status-poll timeout, malformed/unparseable primer response, missing
  `num_ctx` guard tripping) resolves to `primer_context: None` reaching
  `/level` — never an exception propagating out of the primer call itself.
  Also test that `DELETE /api/v1/files/{id}` fires on the error paths,
  not only the success path — a `try`/`finally` around the upload, not a
  bare `try`/`except` that skips cleanup on a thrown error.

