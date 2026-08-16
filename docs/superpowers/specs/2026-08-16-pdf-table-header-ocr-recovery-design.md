# PDF Table-Cell OCR Recovery — Design

Date: 2026-08-16
Status: Approved, pending implementation plan

## Problem

Live SURVEY validation of `cubeadcs_icd.pdf`'s "Summary of CubeADCS Variants"
table (page 14) surfaced a broken-looking rendered table: the header row
showed as unreadable thin colored slivers instead of "Variant", "Satellite
Size", "Internal CubeTorquers", etc.

Root-caused via direct inspection of the source PDF (`pdfplumber`/`pypdf`),
not guessed:

- `page.extract_text()` and raw `page.chars` return **zero characters** in
  the header row's vertical band (y=382–409.7pt on page 14) — this is not a
  table-geometry/colspan bug, there is no text there to extract.
- `page.images` contains multiple small (~10–11px tall, word-sized) raster
  images positioned exactly at the header cell coordinates. The header
  labels were authored as individually-embedded raster images, not font
  glyphs — a PDF-authoring artifact (common when a table header is
  copy-pasted from another tool, or exported through a path that rasterizes
  text runs).
- Body-row data is **not** affected: raw pdfplumber extraction confirms
  "Fully functional" and the rest of the `CubeConnect` column's real text
  values are present and correct. The column that looked missing in the
  reviewed screenshot was a horizontal-scroll viewport issue in the
  frontend table renderer, not data loss — out of scope for this spec.

No text-extraction or column-geometry fix can recover this text (there is
nothing to extract) — only OCR, targeted at the specific missing-text
region, can.

## Decisions (confirmed via brainstorming, not open questions)

1. **Trigger scope: any blank cell with real (non-spanned) geometry, not
   just header cells.** A genuinely-blank body data cell is common and
   legitimate; the cost/false-positive risk of attempting OCR recovery on
   one is mitigated by the pre-check below (a truly blank cell costs one
   skipped attempt, never an incorrect insertion).
2. **Always on, no new settings flag.** Matches the existing whole-page OCR
   fallback (`load_pdf_with_ocr_fallback`), which has no opt-in flag either.
3. **OCR-recovered cell text is flagged for review**, not inserted silently
   — a new `WarningKind`, one warning per table (not per cell).
4. **PDF-only.** Docx/pptx are structurally different: a table cell there
   that contains only a picture (no text run) already correctly extracts as
   empty text today — there is no bug, just a theoretical future
   enrichment. The PDF case is different: real label text exists
   conceptually (a human reading the page sees "Variant") but pdfplumber
   cannot see it because it isn't real text. Extending this to docx/pptx is
   an explicit deferred follow-up, not silently in scope here.

## Architecture

Lives entirely in `ingestion/app/loaders/pdf_loader.py`, integrated into the
existing table-building path (`_build_pdf_table_grid`, called from
`load_pdf`'s per-page loop) — this is where pdfplumber's real per-grid-cell
bbox geometry (`found_table`'s own row/column boundaries) still exists,
before it collapses into the simplified `TableCell` Pydantic list. No new
field is added to the public `TableCell`/`Table` models; cell bboxes are
used transiently within this function and discarded.

For every grid position that:
- is not a spanned slot (already `None` from colspan/rowspan folding), and
- has empty/whitespace-only extracted text,

attempt OCR recovery, in this order:

1. **Cheap pre-check (no OCR call).** Crop the page's rendered pixels
   (see below) to the cell's bbox, convert to grayscale (`Image.convert("L")`),
   and compute `PIL.ImageStat.Stat(crop).stddev[0]`. A genuinely-blank cell
   renders as a solid/near-uniform color — stddev below **5** (on the 0–255
   grayscale scale) skips entirely: leave `text=""` unchanged, no warning,
   no OCR call. This is a first-pass conservative default (real text/graphic
   content typically produces stddev well above 20), not a precision-tuned
   constant — the implementer should sanity-check it against a real blank
   cell crop and a real recovered-text crop from the motivating fixture
   during implementation, and adjust if either misfires. This is a pure
   cost optimization regardless of the exact value: correctness never
   depends on it (a real recoverable cell is never visually uniform), so a
   threshold that's too conservative only costs a wasted OCR attempt, never
   a missed recovery or a wrong one.
2. **OCR the crop.** Only reached for cells with real visual content. Calls
   the SAME confidence-filtered logic `ocr_page_to_text_filtered`
   (`ocr.py:29-54`) already uses — `pytesseract.image_to_data(...,
   output_type=Output.DICT)` + drop words below the confidence threshold
   (default 30, unchanged) + join survivors — not the simpler
   `image_to_string`/`ocr_page_to_text`, which is test-only today. Concretely:
   extract `ocr_page_to_text_filtered`'s word-filter-and-join body into a
   small shared helper taking a `PIL.Image` directly (both the existing
   whole-page caller and this new crop-based caller pass it one), rather
   than duplicating the confidence-filtering logic in a second place. Same
   `languages` parameter already threaded through `/ingest` →
   `load_pdf_with_ocr_fallback` → `load_pdf` (no new request parameter).
3. **Write the result** into that grid position's cell text if OCR returned
   non-empty content after stripping; otherwise leave `text=""` unchanged
   (fail-open — an OCR miss must never turn into fabricated content or
   abort the document).

## Rendering: whole-page render, cached per page, then crop

Reuses the exact dependency and rasterization call the existing whole-page
OCR fallback already uses — `pdf2image.convert_from_path` — rather than
introducing a new PDF-rendering path (no PyMuPDF/fitz, no new dependency).

Renders each PAGE **once**, cached by `(path, page_index)` for the duration
of the `load_pdf` call — mirrors `cached_pdf_reader`'s existing
`@lru_cache`-per-path pattern in this same file, for the same reason
(a table with several blank cells, or a page with several tables, must not
re-rasterize the same page repeatedly). Uses `pdf2image`'s default DPI
(~200 — the same implicit default the existing whole-page OCR fallback
already uses via `convert_from_path` with no `dpi` kwarg; not introducing a
separate constant that would need its own justification). A cell's bbox
(in PDF points, from pdfplumber's own table-cell geometry) is scaled to
pixel coordinates via `pixels = points * dpi / 72` before cropping with
`PIL.Image.crop`.

**Rejected alternative:** correlating pdfplumber/pypdf's own embedded-image
objects (`page.images`/`pypdf_page.images`, the same objects `load_pdf`'s
existing figure-extraction loop already reads) with each blank cell's bbox,
and OCR-ing the matched image object(s) directly — no page rendering at
all. Rejected: the real document shows *multiple* small, adjacent image
fragments per label (word- or sub-word-granularity), making correct
left-to-right reassembly fragile; and this approach silently finds nothing
if the missing text isn't backed by a discrete raster image at all (e.g.
vector/path-rendered text), whereas cropping rendered pixels recovers text
regardless of the underlying PDF content-stream representation.

## Warning integration

New `WarningKind.OCR_RECOVERED_TABLE_TEXT`, severity `NEEDS_REVIEW`,
registered via the same 3-place convention every `WarningKind` in this
project's recent work has used:
- `ingestion/app/workitem/model.py`'s enum + `WARNING_SEVERITY` dict
- `shared/schemas/work-item-tree.schema.json`'s closed `IntegrityWarning.kind` enum
  (with the required `shared/ts` regeneration + `generated.spec.ts` check in
  the same commit)

**One warning per table**, not per cell — matches this codebase's
established "dedupe at the table/section level" convention (e.g. Task 1's
exact-text dedup, Task 5's per-table-id dedup). `detail` includes the
table's id and the count of recovered cells, so a reviewer knows exactly
which table to spot-check against the source PDF.

## Explicitly out of scope

- Docx/pptx (see Decision 4 above).
- Per-word bounding-box-based OCR correlation (the rejected alternative
  above) — may be revisited if the render-and-crop approach proves too
  slow in practice, but not attempted now without evidence it's needed.
- Any change to the frontend table renderer / horizontal-scroll behavior —
  the "missing CubeConnect column" observation in the originating
  screenshot was confirmed to be a viewport/scroll issue, not a data bug,
  and is unrelated to this spec.
- Confidence-threshold tuning beyond mirroring `ocr_page_to_text_filtered`'s
  existing default (30) — not re-litigated here.

## Regression safety — this must not touch figure processing

Figure analysis (vision captioning, significance filtering, degenerate-
image filtering, decorative-figure display, caption brevity/repetition —
all 10 fixes landed earlier today) is currently correct end-to-end,
confirmed on a real completed job. This spec's change must not risk any of
it. Concretely:

- **Touches only table code.** The new logic lives entirely inside/adjacent
  to `_build_pdf_table_grid` and writes only to `TableCell.text`. It never
  calls `describe_figure`, never touches `_is_degenerate_pdf_image`,
  `Figure` construction, `orchestrator_vision_client.py`,
  `narration_publisher.py`, or `main.py`'s figure-caption Redis cache
  (`_figure_caption_cache_key`/`PROMPT_VERSION`) — none of today's 10 fixes
  live in or near `_build_pdf_table_grid`, and this spec adds no call from
  the new code into any of that machinery.
- **New cache is separate from the existing one.** The per-page rendered-
  image cache this spec introduces is a NEW cache (keyed by
  `(path, page_index)`, storing a `PIL.Image` from `pdf2image`) —
  independent from `cached_pdf_reader`'s existing `@lru_cache` (keyed by
  `path`, storing a `pypdf.PdfReader`), which figure extraction also reads
  (`pypdf_page.images`). The new cache must not wrap, invalidate, or share
  storage with `cached_pdf_reader` — implemented as a second, distinctly-
  named cache, not a parameter added to the existing one.
- **The "table" and "image" branches in `load_pdf`'s per-page merged loop
  stay structurally separate** (unchanged from today): this spec only adds
  code inside the existing `if kind == "table":` branch's own table-
  building call, never inside the `else:` (image/figure) branch.
- **Full-suite regression gate, not just new tests passing.** Before this
  work is considered done: run the complete `ingestion/tests/` suite (not
  a subset) and diff the pass/fail count against today's known baseline
  (1436 passed, 1 pre-existing/order-dependent-flaky unrelated failure —
  `test_ingest_survey_mode_still_captions_when_vision_is_configured`).
  Specifically confirm zero changed assertions/behavior in every figure-
  and vision-related test file (`test_orchestrator_vision_client.py`,
  `test_ingest_caption_status.py`, and every figure-specific test in
  `test_pdf_loader.py`/`test_docx_loader.py`/`test_pptx_loader.py`) — the
  implementation plan must include this as an explicit, named verification
  step, not leave it implicit in "run the tests."

## Testing

- **Unit tests** for the new bbox-scale/crop/pre-check/OCR-recovery
  function directly: a mocked `pytesseract` call to assert (a) the
  pre-check skips a uniform/blank crop without ever calling OCR (assert via
  a mock that fails the test if called), (b) a non-uniform crop reaches the
  OCR call with correctly-scaled pixel coordinates, (c) empty OCR output
  leaves the cell untouched (fail-open), (d) non-empty OCR output writes
  the recovered text and is reflected in the table's collected warning.
- **Integration test** using a synthetic PDF fixture built the same way the
  existing `scanned_sample.pdf` fixture is (`build_scanned_pdf_fixture.py`,
  reportlab): a real table with normal-text body cells and one header cell
  whose content is a reportlab-drawn image of text baked in — proving
  end-to-end recovery through `load_pdf` plus the new
  `OCR_RECOVERED_TABLE_TEXT` warning firing with the correct table id/count.
- **Regression test** proving a genuinely-blank real data cell (normal text
  table, one cell intentionally left empty) is left untouched: no OCR call
  (mocked to fail the test if invoked), no warning, `text=""` unchanged —
  confirms the "any blank cell" scope (Decision 1) doesn't misfire on
  legitimate empty data.
- Existing whole-page OCR fallback tests (`test_ocr.py`,
  `test_pdf_loader.py`'s scanned-page tests) are unaffected — this is an
  independent, narrower repair that fires regardless of whether the page as
  a whole is classified as "scanned" (a genuinely fully-scanned page has no
  real pdfplumber table geometry to begin with, so this repair is naturally
  moot there).
- `shared/ts` regeneration + `generated.spec.ts` pass in the same commit as
  the schema change, per this project's own standing requirement.
