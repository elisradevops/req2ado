# PDF Table-Cell OCR Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover text for PDF table grid positions whose text pdfplumber cannot extract (because the label was authored as a small embedded raster image, not real font glyphs) by rendering the page and OCR-ing that cell's own cropped region, flagging every table with recovered text via a new `IntegrityWarning` for human review.

**Architecture:** Lives entirely inside `ingestion/app/loaders/pdf_loader.py`'s existing table-building path (`_build_pdf_table_grid`, called from `load_pdf`'s per-page loop). For every non-spanned grid position whose extracted text is empty/whitespace, crop a cached whole-page render (`pdf2image.convert_from_path`, reusing the existing whole-page-OCR-fallback dependency, no new rendering path) to that cell's bbox, run a cheap grayscale-uniformity pre-check to skip genuinely blank cells without an OCR call, and OCR survivors via the same confidence-filtered logic `ocr_page_to_text_filtered` already uses (extracted into a shared helper both call). A new `TableCell.ocr_recovered: bool` field on the canonical model bridges this ingest-time signal into a real `WorkItemTree.warnings` entry later, during BASELINE's `tree_builder.py` and SURVEY's `llm_leveling.py` tree-building — mirroring the established `Figure.caption_status` bridging pattern, since `CanonicalDoc` itself has no warnings concept.

**Tech Stack:** Python (ingestion package only — no orchestrator/frontend changes). Existing dependencies only: `pdfplumber`, `pdf2image`, `pytesseract`, `Pillow`, `pydantic`. `reportlab` (already a test-only dependency, used by `build_scanned_pdf_fixture.py` and siblings) for 2 new synthetic PDF test fixtures.

## Global Constraints

- **PDF-only.** Do not touch `docx_loader.py`/`pptx_loader.py`/`xlsx_loader.py` — a table cell containing only a picture there already correctly extracts as empty text today; that is not a bug (see the spec's Decision 4).
- **Always on, no new settings/env var/request parameter.** Matches `load_pdf_with_ocr_fallback`'s own existing no-opt-in convention. The feature is driven entirely by the SAME `languages` value already threaded from the request through `dispatch.py` → `load_pdf_with_ocr_fallback` — Task 1 below closes the one real gap in that chain (it stops at `load_pdf`'s own missing parameter).
- **Trigger scope: any grid position with real (non-spanned) geometry and empty/whitespace-only extracted text** — not header-only. A genuinely blank body cell is legitimate; the pre-check (Task 5) makes attempting recovery on one cost nothing but one skipped attempt.
- **Fail-open, always.** An OCR miss (blank pre-check, empty OCR result, any exception) must leave `text=""` unchanged and never abort the document. No new exception type may propagate out of the new code into `load_pdf`'s caller.
- **`WarningKind` is a closed vocabulary enforced in 3 places every time**: `ingestion/app/workitem/model.py`'s enum + `WARNING_SEVERITY` dict + `shared/schemas/work-item-tree.schema.json`'s closed enum. Never add one without all 3, and always regenerate + verify `shared/ts` (`cd shared/ts && pnpm generate && pnpm test`) in the same commit as the schema edit.
- **`CanonicalDoc`/`Table`/`TableCell` are closed schemas** (`additionalProperties: false` in `shared/schemas/canonical-doc.schema.json`), enforced by `ingestion/tests/test_schema_conformance.py`. Any new field needs a matching schema edit in the same commit.
- **One warning per table, not per cell.** Matches this codebase's established table/section-level dedup convention (`_unsupported_content_warnings`, `_referenced_attachment_warnings`).
- **Regression safety (from the approved spec, non-negotiable):** this work must not touch figure processing in any way — no call from any new code into `describe_figure`, `_is_degenerate_pdf_image`, `Figure` construction, `orchestrator_vision_client.py`, `narration_publisher.py`, or `main.py`'s figure-caption Redis cache. The new per-page render cache (Task 5) must be a second, distinctly-named cache — never wrapping, invalidating, or sharing storage with `cached_pdf_reader`'s existing `@lru_cache`. The final task (Task 8) includes a named, explicit full-suite regression gate: run all of `ingestion/tests/` (not a subset), diff the pass/fail count against today's known baseline (1436 passed, 1 pre-existing/order-dependent-flaky unrelated failure — `test_ingest_survey_mode_still_captions_when_vision_is_configured`), and confirm zero changed assertions in every figure/vision-related test file (`test_orchestrator_vision_client.py`, `test_ingest_caption_status.py`, every figure-specific test in `test_pdf_loader.py`/`test_docx_loader.py`/`test_pptx_loader.py`).
- **Test conventions:** ingestion = pytest, files at `ingestion/tests/test_<module>.py`, run via `cd ingestion && source .venv/bin/activate && pytest tests/<file>.py -v` (or `pytest tests/` for the full suite).
- **No placeholders.** Every step below has exact code, not a description of code.

---

## Discovered gaps this plan resolves (found during planning, not yet in code)

1. **`load_pdf` has no `languages` parameter today.** `load_pdf_with_ocr_fallback` (`ingestion/app/loaders/ocr.py:57-103`) already receives the real per-request `languages` value (confirmed: `dispatch.py:78` is the only PDF call site and already passes `languages=languages` into `load_pdf_with_ocr_fallback`), but its own 2 internal calls to `load_pdf(...)` (lines 65, 71) never forward it, and `load_pdf`'s signature (`pdf_loader.py:1193-1195`) has no such parameter to forward it TO. Task 1 closes this.
2. **`CanonicalDoc` has no warnings concept.** `IntegrityWarning`/`WorkItemTree.warnings` only exist from `/level` (`tree_builder.py` BASELINE, `llm_leveling.py` SURVEY) onward — never during `/ingest` (`pdf_loader.py`/`load_pdf`). Resolved via the same bridging pattern already used twice in this codebase (`Figure.caption_status`, `CanonicalDoc.failed_figure_storage_ids`): a plain ingest-time field (`TableCell.ocr_recovered`, Task 2) converted to a real warning later, during tree-building (Task 7, in BOTH `tree_builder.py` and `llm_leveling.py`).
3. **A naive pre-check crop (no inset) misfires on every genuinely blank bordered cell.** Empirically confirmed against a real reportlab-built ruled table: an intentionally blank cell's raw pdfplumber bbox crop has grayscale stddev ~50 (extrema 0-255) purely from the ruled grid border line sitting exactly on the bbox edge — comfortably clearing any reasonable "blank" threshold and misfiring into a wasted (though still fail-open) OCR attempt on every blank cell in every bordered table. Insetting the crop 2pt from each bbox edge before computing stddev (verified: the same cell becomes pure white, stddev 0.0, once inset past the border) restores the intended "uniform color = blank" assumption. Task 5 includes this inset as a named constant with the empirical justification in its own comment.

---

## Task 1: Thread `languages` through `load_pdf`

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py:1193-1195` (signature only)
- Modify: `ingestion/app/loaders/ocr.py:64-65,71` (both `load_pdf(...)` call sites)
- Test: `ingestion/tests/test_ocr.py`

**Interfaces:**
- Consumes: nothing new — `load_pdf_with_ocr_fallback`'s existing `languages: str = "eng"` parameter (already correctly populated from the real request, confirmed via `dispatch.py:78`).
- Produces: `load_pdf(path, describe_figure=None, text_only=False, languages="eng")` — a new keyword parameter, default-compatible with every existing call site in the codebase (none currently pass a 4th positional/keyword arg, so this is purely additive).

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_ocr.py` (check the existing imports at the top of that file first — it already imports `load_pdf_with_ocr_fallback` and typically patches `app.loaders.ocr.load_pdf`):

```python
def test_load_pdf_with_ocr_fallback_forwards_languages_to_load_pdf_when_nothing_is_scanned() -> None:
    # any_scanned=False branch (ocr.py:64-65) -- the common case for a real
    # document that has extractable text overall but individual table cells
    # missing text (the motivating bug this whole plan exists to fix).
    from unittest.mock import patch

    from app.canonical.model import CanonicalDoc, Document, DocumentFormat

    fake_doc = CanonicalDoc(document=Document(path="x", format=DocumentFormat.PDF, sha256="h"))
    with patch("app.loaders.ocr.page_has_extractable_text", return_value=True), \
         patch("app.loaders.ocr.load_pdf") as mock_load_pdf:
        mock_load_pdf.return_value = fake_doc
        load_pdf_with_ocr_fallback(str(FIXTURES / "sample.pdf"), languages="heb+eng")
    mock_load_pdf.assert_called_once_with(str(FIXTURES / "sample.pdf"), describe_figure=None, languages="heb+eng")


def test_load_pdf_with_ocr_fallback_forwards_languages_to_load_pdf_when_a_page_is_scanned() -> None:
    # any_scanned=True branch (ocr.py:71) -- the text_doc build call, a
    # separate call site from the one above with its own independent gap.
    from unittest.mock import patch

    from app.canonical.model import CanonicalDoc, Document, DocumentFormat

    fake_doc = CanonicalDoc(document=Document(path="x", format=DocumentFormat.PDF, sha256="h"))
    with patch("app.loaders.ocr.page_has_extractable_text", return_value=False), \
         patch("app.loaders.ocr.ocr_page_to_text_filtered", return_value=""), \
         patch("app.loaders.ocr.load_pdf") as mock_load_pdf:
        mock_load_pdf.return_value = fake_doc
        load_pdf_with_ocr_fallback(str(FIXTURES / "scanned_sample.pdf"), languages="heb+eng")
    mock_load_pdf.assert_called_once_with(str(FIXTURES / "scanned_sample.pdf"), describe_figure=None, languages="heb+eng")
```

(`FIXTURES` should already be defined near the top of `test_ocr.py` as `Path(__file__).parent / "fixtures"` — check first; if the file defines it differently, use the existing name.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_ocr.py -v -k forwards_languages`
Expected: both FAIL — `mock_load_pdf.assert_called_once_with(...)` raises `AssertionError` because today's calls omit `languages=`.

- [ ] **Step 3: Implement the minimal fix**

In `ingestion/app/loaders/pdf_loader.py`, change the `load_pdf` signature (line 1193-1195):

```python
def load_pdf(
    path: str,
    describe_figure: Callable[[bytes], str | None] | None = None,
    text_only: bool = False,
    languages: str = "eng",
) -> CanonicalDoc:
```

Update its docstring (currently ends after the `text_only` paragraph) by appending one paragraph:

```
    `languages` is passed to Tesseract's `lang` parameter wherever this
    document's page-level OCR fallback or table-cell OCR recovery runs
    (see app/loaders/ocr.py and _cell_ocr_recovery below) -- has no effect
    on a document with no OCR-eligible content at all. Default "eng"
    matches every existing call site that predates this parameter.
```

In `ingestion/app/loaders/ocr.py`, update both `load_pdf(...)` calls inside `load_pdf_with_ocr_fallback`:

```python
    any_scanned = any(not page_has_extractable_text(path, i) for i in range(num_pages))
    if not any_scanned:
        return load_pdf(path, describe_figure=describe_figure, languages=languages)

    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF_SCANNED, sha256=sha256)

    text_doc = load_pdf(path, describe_figure=describe_figure, languages=languages)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_ocr.py -v`
Expected: all PASS, including the 2 new tests and every pre-existing test in this file (this change is purely additive to `load_pdf`'s signature).

- [ ] **Step 5: Run the full pdf_loader suite to confirm no regression**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v`
Expected: all PASS (every existing call to `load_pdf(...)` in that file omits the new `languages` kwarg and gets the default `"eng"`, byte-identical to today's behavior).

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/app/loaders/ocr.py ingestion/tests/test_ocr.py
git commit -m "fix(ingestion): thread languages parameter through load_pdf

load_pdf_with_ocr_fallback already received the real per-request
languages value but never forwarded it into its own load_pdf(...) calls,
and load_pdf had no such parameter to receive it. Closes this gap ahead
of table-cell OCR recovery, which needs the real value to reach load_pdf."
```

---

## Task 2: Add `TableCell.ocr_recovered` field

**Files:**
- Modify: `ingestion/app/canonical/model.py` (`TableCell` class, currently lines 101-125)
- Modify: `shared/schemas/canonical-doc.schema.json` (`TableCell` definition)
- Test: `ingestion/tests/test_schema_conformance.py`

**Interfaces:**
- Produces: `TableCell.ocr_recovered: bool` (default `False`) — read by Task 7's warning-bridging code in `tree_builder.py`/`llm_leveling.py`; set by Task 6's wiring in `pdf_loader.py`.

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_schema_conformance.py` (near the existing `test_schema_accepts_a_populated_failed_figure_storage_ids`/`test_schema_accepts_each_real_figure_caption_status_value` tests — check that file's existing `schema` fixture and a minimal valid `CanonicalDoc`-shaped dict helper before writing this, to match its established construction style):

```python
def test_schema_accepts_an_ocr_recovered_table_cell(schema) -> None:
    doc = _minimal_canonical_doc()  # use whatever this file's existing minimal-doc helper is named
    doc["tables"] = [
        {
            "id": "t0",
            "cells": [[{"text": "Label", "ocr_recovered": True}, {"text": "Alpha", "ocr_recovered": False}]],
            "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1},
        }
    ]
    jsonschema.validate(instance=doc, schema=schema)


def test_schema_rejects_a_non_boolean_ocr_recovered(schema) -> None:
    doc = _minimal_canonical_doc()
    doc["tables"] = [
        {
            "id": "t0",
            "cells": [[{"text": "Label", "ocr_recovered": "yes"}]],
            "source_ref": {"document_path": "x", "start_offset": 0, "end_offset": 1},
        }
    ]
    with pytest.raises(jsonschema.exceptions.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)
```

(If this file has no existing `_minimal_canonical_doc()`-style helper, build the dict inline the same way its neighboring tests already do — check `test_schema_accepts_a_populated_failed_figure_storage_ids` immediately above for the exact minimal-doc shape this file already uses, and copy that shape rather than inventing a new one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_schema_conformance.py -v -k ocr_recovered`
Expected: `test_schema_accepts_an_ocr_recovered_table_cell` FAILS with a `ValidationError` (`additionalProperties: false` rejects the unknown `ocr_recovered` key); `test_schema_rejects_a_non_boolean_ocr_recovered` FAILS to raise (same reason — the whole object is rejected before the type check on `ocr_recovered` is ever reached, which is itself the wrong rejection reason).

- [ ] **Step 3: Add the field**

In `ingestion/app/canonical/model.py`, in the `TableCell` class (after the existing `align` field):

```python
    align: Literal["left", "center", "right", "justify"] | None = None
    # Set by pdf_loader.py's _cell_ocr_recovery when this cell's text could
    # not be extracted directly (pdfplumber found zero real characters at
    # this grid position) and was instead reconstructed by rendering the
    # page to pixels and OCR-ing this cell's own cropped region -- see
    # docs/superpowers/specs/2026-08-16-pdf-table-header-ocr-recovery-design.md.
    # PDF-only (that spec's Decision 4); never True for a spanned (None)
    # grid position, which has no TableCell at all. This field itself
    # carries no reviewer-facing text -- it's the bridge value CanonicalDoc
    # needs since it has no warnings concept of its own (same bridging
    # convention as Figure.caption_status, see that field's own docstring);
    # tree_builder.py/llm_leveling.py turn a table with any True cell into
    # one IntegrityWarning(WarningKind.OCR_RECOVERED_TABLE_TEXT).
    ocr_recovered: bool = False
```

In `shared/schemas/canonical-doc.schema.json`, find the `TableCell` definition (its `properties` block currently ends with `align`) and add:

```json
        "ocr_recovered": {
          "type": "boolean",
          "default": false,
          "description": "Set when this cell's text could not be extracted directly and was recovered via OCR on a rendered crop -- see TableCell.ocr_recovered's own docstring in canonical/model.py."
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_schema_conformance.py -v`
Expected: all PASS.

- [ ] **Step 5: Run the full ingestion suite to confirm no regression**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/ -q`
Expected: same pass count as today's baseline (1436 passed, 1 pre-existing unrelated failure) plus the new tests from this task.

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/canonical/model.py shared/schemas/canonical-doc.schema.json ingestion/tests/test_schema_conformance.py
git commit -m "feat(ingestion): add TableCell.ocr_recovered field

Bridges the upcoming table-cell OCR recovery signal from ingest time
(CanonicalDoc has no warnings concept) into a real IntegrityWarning later
during tree-building -- same pattern as Figure.caption_status."
```

---

## Task 3: Extract shared confidence-filtered OCR helper

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (new function + new imports)
- Modify: `ingestion/app/loaders/ocr.py` (`ocr_page_to_text_filtered` body only)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Produces: `ocr_image_to_text_filtered(image: Image.Image, languages: str = "eng", confidence_threshold: int = 30) -> str` in `pdf_loader.py` — consumed by Task 5's `_cell_ocr_recovery` and by `ocr.py`'s refactored `ocr_page_to_text_filtered`.
- **Why this lives in `pdf_loader.py`, not `ocr.py`:** `ocr.py` already imports `load_pdf`/`page_has_extractable_text` FROM `pdf_loader.py` (`ocr.py:14`). Defining the shared helper in `ocr.py` and importing it back into `pdf_loader.py` (which Task 5's cell-recovery code needs) would be a circular import. Defining it in `pdf_loader.py` and having `ocr.py` import one more name from there preserves the existing one-directional dependency.

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_pdf_loader.py` (add `ocr_image_to_text_filtered` to the existing `from app.loaders.pdf_loader import (...)` block at the top of the file):

```python
def test_ocr_image_to_text_filtered_drops_low_confidence_words() -> None:
    from unittest.mock import patch

    fake_data = {"text": ["Real", "watermark", ""], "conf": ["90", "5", "-1"]}
    with patch("app.loaders.pdf_loader.pytesseract.image_to_data", return_value=fake_data):
        from PIL import Image

        result = ocr_image_to_text_filtered(Image.new("RGB", (10, 10)), languages="eng", confidence_threshold=30)
    assert result == "Real"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v -k ocr_image_to_text_filtered`
Expected: FAIL with `ImportError`/`NameError` — `ocr_image_to_text_filtered` does not exist yet in `pdf_loader.py`.

- [ ] **Step 3: Implement**

In `ingestion/app/loaders/pdf_loader.py`, add these imports after the existing `from pypdf import PdfReader` line:

```python
import pytesseract
from pdf2image import convert_from_path
from PIL import Image, ImageStat
from pytesseract import Output
```

Add this function near the top of the table-fidelity section (right before `_build_pdf_table_grid` is a reasonable home, since Task 5 will add the cell-recovery function right next to it too):

```python
def ocr_image_to_text_filtered(
    image: Image.Image, languages: str = "eng", confidence_threshold: int = 30
) -> str:
    """Confidence-filtered OCR over an already-in-memory PIL image -- the
    shared body both app/loaders/ocr.py's ocr_page_to_text_filtered
    (whole-page: renders then delegates here) and _cell_ocr_recovery below
    (crops a rendered page then delegates here) use, so the confidence-
    filtering rule (drop any word below confidence_threshold on
    Tesseract's 0-100 scale; -1, a non-text region, always dropped) exists
    in exactly one place. Lives here rather than in ocr.py because ocr.py
    already imports load_pdf/page_has_extractable_text FROM this module --
    defining this helper in ocr.py and importing it back here (needed for
    _cell_ocr_recovery) would be a circular import.
    """
    data = pytesseract.image_to_data(image, lang=languages, output_type=Output.DICT)
    kept_words = [
        word
        for word, conf in zip(data["text"], data["conf"])
        if word.strip() and int(conf) >= confidence_threshold
    ]
    return " ".join(kept_words)
```

In `ingestion/app/loaders/ocr.py`, replace `ocr_page_to_text_filtered`'s body (keep its existing docstring verbatim — it documents the watermark-mitigation rationale, which still applies unchanged) to delegate:

```python
def ocr_page_to_text_filtered(
    path: str, page_index: int, languages: str = "eng", confidence_threshold: int = 30
) -> str:
    """Best-effort watermark mitigation: drops words below `confidence_threshold`
    (Tesseract's 0-100 confidence scale; -1 means non-text region, always
    dropped). Watermarks are OFTEN rendered fainter than body text, which
    OFTEN produces lower OCR confidence -- but this is a heuristic, not a
    guarantee. It will not detect a watermark rendered at similar contrast
    to body text, and may occasionally drop genuine low-confidence body
    text (e.g. blurry scans). Empirically (see tests/fixtures/build_
    watermarked_pdf_fixture.py), Tesseract's own binarization step often
    excludes faint text as a word candidate entirely -- rather than
    detecting it at a low-but-nonzero confidence -- so this filter cannot
    be relied on to discriminate a watermark that IS detected as text from
    body text; it only helps when a watermark IS detected but scored low.
    Full watermark detection (image-processing based) is out of scope for
    this function."""
    images = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
    return ocr_image_to_text_filtered(images[0], languages=languages, confidence_threshold=confidence_threshold)
```

Update `ocr.py`'s import line to add the new name:

```python
from app.loaders.pdf_loader import load_pdf, ocr_image_to_text_filtered, page_has_extractable_text
```

`ocr.py` no longer uses `pytesseract`/`Output` directly in this function, but `ocr_page_to_text` (the test-only, unfiltered sibling function just above it) still does — leave `import pytesseract`/`from pytesseract import Output` in `ocr.py` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py tests/test_ocr.py -v`
Expected: all PASS, including every pre-existing `ocr_page_to_text_filtered` test (this is a behavior-preserving refactor — same inputs produce the same output, just via a shared function).

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/app/loaders/ocr.py ingestion/tests/test_pdf_loader.py
git commit -m "refactor(ingestion): extract ocr_image_to_text_filtered shared helper

Confidence-filtered OCR body now lives in one place (pdf_loader.py, to
avoid a circular import with ocr.py) so the upcoming table-cell OCR
recovery path and the existing whole-page OCR fallback share identical
filtering logic instead of duplicating it."
```

---

## Task 4: Register `WarningKind.OCR_RECOVERED_TABLE_TEXT`

**Files:**
- Modify: `ingestion/app/workitem/model.py` (`WarningKind` enum + `WARNING_SEVERITY` dict)
- Modify: `shared/schemas/work-item-tree.schema.json` (`IntegrityWarning.kind.enum`)
- Modify: `shared/ts/src/generated/*.ts` (regenerated, not hand-edited)
- Test: `ingestion/tests/test_worktree_schema_conformance.py`

**Interfaces:**
- Produces: `WarningKind.OCR_RECOVERED_TABLE_TEXT` (severity `NEEDS_REVIEW`) — consumed by Task 7's warning-bridging code.

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_worktree_schema_conformance.py` (mirrors `test_unsupported_content_note_warning_matches_work_item_tree_schema` immediately above it):

```python
def test_ocr_recovered_table_text_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.OCR_RECOVERED_TABLE_TEXT,
            "Table t0 had 3 cell(s) recovered via OCR -- please spot-check against the source document.",
            detail={"tableId": "t0", "recoveredCellCount": 3},
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_worktree_schema_conformance.py -v -k ocr_recovered_table_text`
Expected: FAIL with `AttributeError: OCR_RECOVERED_TABLE_TEXT` (the enum member doesn't exist yet).

- [ ] **Step 3: Register the new kind**

In `ingestion/app/workitem/model.py`, add to the `WarningKind` enum (after `VISION_CAPTIONING_DISABLED`, the current last member):

```python
    VISION_CAPTIONING_DISABLED = "vision_captioning_disabled"
    # PDF-only (docs/superpowers/specs/2026-08-16-pdf-table-header-ocr-recovery-design.md):
    # a table had 1+ grid position whose text could not be extracted
    # directly and was instead reconstructed via OCR on a rendered crop
    # (see TableCell.ocr_recovered, pdf_loader.py's _cell_ocr_recovery).
    # One warning per TABLE with any such cell, not per cell -- matches
    # this codebase's established table/section-level dedup convention.
    OCR_RECOVERED_TABLE_TEXT = "ocr_recovered_table_text"
```

Add to `WARNING_SEVERITY` (after the `MAPPING_CALL_FAILED` entry, the current last one):

```python
    WarningKind.MAPPING_CALL_FAILED: WarningSeverity.PIPELINE_ISSUE,
    WarningKind.OCR_RECOVERED_TABLE_TEXT: WarningSeverity.NEEDS_REVIEW,
}
```

In `shared/schemas/work-item-tree.schema.json`, add `"ocr_recovered_table_text"` to the `IntegrityWarning.kind.enum` array (after `"mapping_call_failed"`):

```json
            "unsupported_content_note", "empty_table_content",
            "vision_captioning_disabled", "invalid_mapping_target", "mapping_call_failed",
            "ocr_recovered_table_text"
```

- [ ] **Step 4: Regenerate shared/ts and verify the drift guard**

Run:
```bash
cd shared/ts && pnpm generate && pnpm test
```
Expected: `pnpm generate` rewrites `src/generated/*.ts` to include the new enum value; `pnpm test` (runs `generated.spec.ts`'s drift guard among the rest of the suite) passes, confirming the regenerated output is committed and matches the schema.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_worktree_schema_conformance.py -v`
Expected: all PASS.

- [ ] **Step 6: Run the full ingestion suite to confirm no regression**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/ -q`
Expected: baseline pass count (1436 passed, 1 pre-existing unrelated failure) plus this task's new test.

- [ ] **Step 7: Commit**

```bash
git add ingestion/app/workitem/model.py shared/schemas/work-item-tree.schema.json shared/ts/src/generated ingestion/tests/test_worktree_schema_conformance.py
git commit -m "feat(ingestion,shared): register OCR_RECOVERED_TABLE_TEXT WarningKind

Registered ahead of the table-cell OCR recovery feature itself (Tasks 5-7)
so later tasks can emit it without also touching the 3-place closed-
vocabulary registration."
```

---

## Task 5: Implement `_cell_ocr_recovery`

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (new function + new module-level constants)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `ocr_image_to_text_filtered` (Task 3).
- Produces: `_cell_ocr_recovery(path: str, page_index: int, bbox: tuple[float, float, float, float], languages: str, page_image_cache: dict[int, Image.Image]) -> str` — consumed by Task 6's wiring into `_build_pdf_table_grid`. `bbox` is `(x0, top, x1, bottom)` in PDF points, the same shape `_colspan_rowspan`/`_pdf_cell_chars` already use elsewhere in this file. `page_image_cache` is a plain dict the CALLER owns and creates fresh per `load_pdf` call (Task 6 creates it) — this function only reads/populates it, never clears it; this is what makes the cache's lifetime "one `load_pdf` call," not global/module-level, and keeps it a second, distinctly-named cache from `cached_pdf_reader`'s own `@lru_cache` (per this plan's Global Constraints).

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_pdf_loader.py` (add `_cell_ocr_recovery` to the existing import block):

```python
def test_cell_ocr_recovery_skips_a_uniform_blank_crop_without_calling_ocr() -> None:
    from unittest.mock import patch

    from PIL import Image

    blank_page = Image.new("RGB", (1000, 1000), color="white")
    cache: dict[int, Image.Image] = {0: blank_page}
    with patch(
        "app.loaders.pdf_loader.pytesseract.image_to_data",
        side_effect=AssertionError("OCR must not be called for a uniform/blank crop"),
    ):
        result = _cell_ocr_recovery("unused.pdf", 0, (10.0, 10.0, 100.0, 40.0), "eng", cache)
    assert result == ""


def test_cell_ocr_recovery_reaches_ocr_with_a_correctly_scaled_and_inset_crop() -> None:
    from unittest.mock import patch

    from PIL import Image

    # Real per-pixel noise (not a hand-drawn shape) guarantees the crop is
    # non-uniform regardless of exact inset/scale rounding, so this test
    # only needs to assert the crop SIZE reaching OCR, not its content.
    page_image = Image.effect_noise((400, 400), 60).convert("RGB")
    cache: dict[int, Image.Image] = {0: page_image}
    captured: dict[str, tuple[int, int]] = {}

    def fake_ocr(image: Image.Image, languages: str) -> str:
        captured["size"] = image.size
        return "RECOVERED"

    with patch("app.loaders.pdf_loader.ocr_image_to_text_filtered", side_effect=fake_ocr):
        result = _cell_ocr_recovery("unused.pdf", 0, (10.0, 10.0, 100.0, 40.0), "eng", cache)

    assert result == "RECOVERED"
    scale = 200 / 72
    expected_width = (100.0 - 2.0 - (10.0 + 2.0)) * scale
    expected_height = (40.0 - 2.0 - (10.0 + 2.0)) * scale
    assert abs(captured["size"][0] - expected_width) <= 1
    assert abs(captured["size"][1] - expected_height) <= 1


def test_cell_ocr_recovery_returns_empty_string_when_ocr_finds_nothing() -> None:
    from unittest.mock import patch

    from PIL import Image

    page_image = Image.effect_noise((400, 400), 60).convert("RGB")
    cache: dict[int, Image.Image] = {0: page_image}
    with patch("app.loaders.pdf_loader.ocr_image_to_text_filtered", return_value=""):
        result = _cell_ocr_recovery("unused.pdf", 0, (10.0, 10.0, 100.0, 40.0), "eng", cache)
    assert result == ""


def test_cell_ocr_recovery_renders_the_page_once_and_caches_it() -> None:
    from unittest.mock import patch

    from PIL import Image

    page_image = Image.effect_noise((400, 400), 60).convert("RGB")
    cache: dict[int, Image.Image] = {}
    with patch("app.loaders.pdf_loader.convert_from_path", return_value=[page_image]) as mock_convert, \
         patch("app.loaders.pdf_loader.ocr_image_to_text_filtered", return_value="x"):
        _cell_ocr_recovery("some.pdf", 2, (10.0, 10.0, 100.0, 40.0), "eng", cache)
        _cell_ocr_recovery("some.pdf", 2, (110.0, 10.0, 200.0, 40.0), "eng", cache)
    mock_convert.assert_called_once_with("some.pdf", first_page=3, last_page=3)
    assert 2 in cache
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v -k cell_ocr_recovery`
Expected: all 4 FAIL with `ImportError`/`NameError` — `_cell_ocr_recovery` does not exist yet.

- [ ] **Step 3: Implement**

In `ingestion/app/loaders/pdf_loader.py`, add these constants and the function directly above `_build_pdf_table_grid`:

```python
# Matches pdf2image.convert_from_path's own default DPI (200) -- not a new,
# independently-tuned value (confirmed: convert_from_path(dpi: int = 200) is
# the library's own default, and every existing call site in this codebase,
# including ocr.py's whole-page fallback, already relies on it implicitly by
# never passing a dpi kwarg). Needed as a concrete number here because
# converting a cell's bbox from PDF points to this rendered image's pixel
# coordinates requires it explicitly (pixels = points * dpi / 72).
_TABLE_OCR_RENDER_DPI = 200

# Points inset from each raw cell-bbox edge before computing the pre-check
# stddev (and before the OCR crop itself -- same crop, reused). Empirically
# required, not a stylistic choice: pdfplumber's own cell bbox extends to
# the ruled grid border line itself (confirmed directly against a real
# bordered table -- an intentionally BLANK cell's un-inset crop measured
# grayscale stddev ~50, extrema 0-255, purely from the border pixels sitting
# on the bbox edge, comfortably clearing any reasonable "blank" threshold;
# the same cell inset by this many points measured stddev 0.0, pure white).
# Without this inset, the pre-check below would misfire into a wasted (if
# still fail-open) OCR attempt on every genuinely blank cell in every
# bordered table. 2.0pt comfortably clears a typical ~1pt ruling line with
# margin, confirmed against both the blank-cell case above and a real
# recovered-text cell (see _BLANK_CELL_STDDEV_THRESHOLD).
_CELL_CROP_INSET_POINTS = 2.0

# A crop's grayscale (0-255 scale) standard deviation below this is treated
# as visually blank -- skip the real OCR call entirely. First-pass
# conservative default (a real blank cell measures 0.0 once inset past its
# border, per _CELL_CROP_INSET_POINTS's own comment; a real recovered-text
# header cell from this feature's motivating fixture measures ~13-46 in
# spot checks). Pure cost optimization, never a correctness dependency: a
# threshold too conservative here only costs one wasted OCR attempt on a
# truly blank cell, never a missed or wrong recovery (see
# docs/superpowers/specs/2026-08-16-pdf-table-header-ocr-recovery-design.md).
_BLANK_CELL_STDDEV_THRESHOLD = 5.0


def _cell_ocr_recovery(
    path: str,
    page_index: int,
    bbox: tuple[float, float, float, float],
    languages: str,
    page_image_cache: dict[int, Image.Image],
) -> str:
    """Attempts to recover text for one table grid position whose
    pdfplumber extraction came back empty, by rendering the page to pixels
    (cached in page_image_cache -- a dict the CALLER creates fresh per
    load_pdf call and owns; this function only reads/populates it, never
    clears it, so its lifetime is exactly one load_pdf call, not global --
    see this function's own Interfaces note in the plan that introduced it)
    and OCR-ing just this cell's bbox crop, inset past the ruled border
    (see _CELL_CROP_INSET_POINTS). Returns "" (fail-open, never raises)
    both when the cheap pre-check judges the crop visually blank (no OCR
    call made at all) and when a real OCR call returns nothing after
    stripping -- a miss here must never turn into fabricated cell content
    or abort the document.
    """
    if page_index not in page_image_cache:
        rendered = convert_from_path(path, first_page=page_index + 1, last_page=page_index + 1)
        page_image_cache[page_index] = rendered[0]
    page_image = page_image_cache[page_index]

    scale = _TABLE_OCR_RENDER_DPI / 72
    x0, top, x1, bottom = bbox
    inset = _CELL_CROP_INSET_POINTS
    x0i, topi, x1i, bottomi = x0 + inset, top + inset, x1 - inset, bottom - inset
    if x1i <= x0i or bottomi <= topi:
        # Cell too small for the inset on at least one axis -- fall back to
        # the raw bbox rather than pass PIL an inverted crop box (which
        # raises). Rare in practice; the pre-check may over-trigger on a
        # tiny cell's own border pixels in this fallback, which only costs
        # one wasted OCR attempt (see _BLANK_CELL_STDDEV_THRESHOLD).
        x0i, topi, x1i, bottomi = x0, top, x1, bottom

    crop = page_image.crop((x0i * scale, topi * scale, x1i * scale, bottomi * scale))
    if ImageStat.Stat(crop.convert("L")).stddev[0] < _BLANK_CELL_STDDEV_THRESHOLD:
        return ""

    return ocr_image_to_text_filtered(crop, languages=languages).strip()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v -k cell_ocr_recovery`
Expected: all 4 PASS.

- [ ] **Step 5: Run the full pdf_loader suite to confirm no regression**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v`
Expected: all PASS (this function is new and not yet called from anywhere else — Task 6 wires it in).

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(ingestion): add _cell_ocr_recovery (render, inset crop, pre-check, OCR)

Not yet wired into table building (Task 6) -- this task lands the
recovery primitive itself with direct unit coverage of the pre-check
skip, the scaled/inset crop math, the fail-open empty-result case, and
the per-page render cache."
```

---

## Task 6: Wire `_cell_ocr_recovery` into `_build_pdf_table_grid`/`load_pdf`

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (`_build_pdf_table_grid`'s signature/body, `load_pdf`'s per-page loop call site and new cache initialization)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `_cell_ocr_recovery` (Task 5), `TableCell.ocr_recovered` (Task 2), `load_pdf`'s new `languages` parameter (Task 1).
- Produces: `_build_pdf_table_grid(page, found_table, path: str, page_index: int, languages: str, page_image_cache: dict[int, Image.Image]) -> tuple[list[list[TableCell | None]], list[float] | None, list[float]]` — same 3-tuple return shape as today (unchanged; `ocr_recovered` travels on the `TableCell` objects already in that tuple, not as a 4th return value). Consumed unchanged by Task 8's integration test and by `load_pdf`'s existing exception-fallback branch (which does NOT call this function on failure — no OCR recovery attempted on a structurally-degraded table, unchanged from today).

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_pdf_loader.py`:

```python
def test_build_pdf_table_grid_calls_ocr_recovery_only_for_empty_text_cells() -> None:
    from unittest.mock import patch

    calls: list[tuple[float, float, float, float]] = []

    def fake_recovery(path, page_index, bbox, languages, cache):
        calls.append(bbox)
        return "RECOVERED" if bbox == (281.0, 78.0, 431.0, 96.0) else ""

    with patch("app.loaders.pdf_loader._cell_ocr_recovery", side_effect=fake_recovery):
        doc = load_pdf(str(FIXTURES / "table_with_blank_cell.pdf"))

    # Exactly one call: the single genuinely-empty-text grid position in
    # this fixture (row 2, col 1) -- every other cell already has real
    # pdfplumber-extracted text and must never reach OCR recovery at all.
    assert len(calls) == 1
    flat = [cell for row in doc.tables[0].cells for cell in row]
    recovered_cells = [c for c in flat if c is not None and c.text == "RECOVERED"]
    assert recovered_cells == []  # this fixture's one empty cell is genuinely blank, fake_recovery returns "" for it
```

(This test only proves the WIRING calls `_cell_ocr_recovery` exactly once, for exactly the empty-text grid position, with real bbox coordinates matching `Task 8`'s fixture geometry -- it does not exercise real OCR at all, keeping this task's test fast and decoupled from Tesseract. `table_with_blank_cell.pdf` does not exist until Task 8 creates it -- **write this test now, but mark it `@pytest.mark.skip(reason="fixture added in Task 8")` for this task's own commit**, then remove the skip mark as part of Task 8's own step 1, where the fixture becomes available. This keeps Task 6's own commit fully green without inventing a second throwaway fixture.)

- [ ] **Step 2: Run the test to verify it is skipped (not failing) for now**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v -k calls_ocr_recovery_only_for_empty`
Expected: SKIPPED (not FAILED) -- confirms the skip mark is correctly applied before the real implementation exists.

- [ ] **Step 3: Implement the wiring**

In `ingestion/app/loaders/pdf_loader.py`, widen `_build_pdf_table_grid`'s signature and body:

```python
def _build_pdf_table_grid(
    page, found_table, path: str, page_index: int, languages: str, page_image_cache: dict[int, Image.Image]
) -> tuple[list[list[TableCell | None]], list[float] | None, list[float]]:
```

(Keep the existing docstring unchanged, and append one paragraph:)

```
    `path`/`page_index`/`languages`/`page_image_cache` exist solely to
    support table-cell OCR recovery (_cell_ocr_recovery) for a grid
    position whose extracted text comes back empty -- see that function's
    own docstring. This never changes this function's return SHAPE (still
    the same 3-tuple as before this parameter existed); a recovered cell's
    text simply lands in the same TableCell.text field a real pdfplumber
    extraction would have, with TableCell.ocr_recovered=True marking it as
    such.
```

Inside the per-cell loop, change:

```python
            text = extracted[row_index][col_index]
            text = text if text is not None else ""
```

to:

```python
            text = extracted[row_index][col_index]
            text = text if text is not None else ""

            ocr_recovered = False
            if not text.strip():
                recovered_text = _cell_ocr_recovery(path, page_index, bbox, languages, page_image_cache)
                if recovered_text:
                    text = recovered_text
                    ocr_recovered = True
```

And change the `TableCell(...)` construction at the end of the loop body to include the new field:

```python
            row_out.append(
                TableCell(
                    text=text,
                    colspan=colspan,
                    rowspan=rowspan,
                    is_header=(row_index == 0),
                    bold=bold,
                    background_color=background_color,
                    text_color=text_color,
                    align=align,
                    ocr_recovered=ocr_recovered,
                )
            )
```

In `load_pdf`'s body, add the per-call render cache right after the existing `table_bbox_by_id: dict[...] = {}` declaration (around line 1225):

```python
    # Rendered-page cache for table-cell OCR recovery (_cell_ocr_recovery)
    # -- lives only for this one load_pdf call (a plain dict, never
    # cleared but also never reused across calls since it's a fresh local
    # here), keyed by page_index (path is fixed for the whole call).
    # Deliberately separate from cached_pdf_reader's own @lru_cache (keyed
    # by path, storing a pypdf.PdfReader, reused ACROSS calls) -- this
    # stores a pdf2image-rendered PIL.Image per page and must never share
    # storage or eviction with that cache (see this plan's Global
    # Constraints / the design spec's Regression Safety section).
    page_image_cache: dict[int, Image.Image] = {}
```

And update the `_build_pdf_table_grid` call site (currently `cells, column_widths, xs = _build_pdf_table_grid(page, found_table)`):

```python
                try:
                    cells, column_widths, xs = _build_pdf_table_grid(
                        page,
                        found_table,
                        path=path,
                        page_index=page_number - 1,
                        languages=languages,
                        page_image_cache=page_image_cache,
                    )
                except Exception:  # noqa: BLE001 -- a structural extraction failure degrades to Phase-1-shaped bare cells, never aborts the document
```

(The `except` block's own body — the bare-`TableCell(text=cell or "")` fallback — is unchanged; it deliberately does NOT attempt OCR recovery, since a structurally-degraded table has already lost span/gap fidelity and is out of scope for this feature.)

Finally, remove the `@pytest.mark.skip(...)` decorator added in Step 1 as part of Task 8's own Step 1 (noted there, not here) once `table_with_blank_cell.pdf` exists.

- [ ] **Step 4: Run the pdf_loader suite**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v`
Expected: all PASS except `test_build_pdf_table_grid_calls_ocr_recovery_only_for_empty_text_cells`, which stays SKIPPED until Task 8. Every pre-existing table test in this file must still pass unchanged (they all use fixtures with zero genuinely-empty-but-real-geometry cells, or already skip the structural-walk path — confirm this by reading each pre-existing table test's fixture before considering this step done; if any pre-existing fixture DOES have a blank real-geometry cell that this change would now start invoking `_cell_ocr_recovery` for, that call is real pytesseract, will be slow, and its result -- even if "" -- must not change that test's existing assertions. Flag any such case to the task reviewer rather than silently patching around it.)

- [ ] **Step 5: Run the full ingestion suite to confirm no regression**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/ -q`
Expected: same pass/skip/fail counts as today's baseline (1436 passed, 1 pre-existing unrelated failure) plus this task's tests (1 passed, 1 skipped).

- [ ] **Step 6: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(ingestion): wire _cell_ocr_recovery into _build_pdf_table_grid

Every table grid position with real (non-spanned) geometry and
empty/whitespace-only extracted text now attempts OCR recovery before
falling back to an empty cell. Structural-walk-failure fallback path is
unchanged -- no recovery attempted there, out of scope for a
already-degraded table."
```

---

## Task 7: Bridge `ocr_recovered` into `IntegrityWarning` (BASELINE + SURVEY)

**Files:**
- Modify: `ingestion/app/leveling/tree_builder.py` (BASELINE, the `if table is not None:` branch, currently lines ~858-883)
- Modify: `ingestion/app/leveling/llm_leveling.py` (SURVEY, new `_ocr_recovered_table_warnings` function + its call site, currently around line 2987-2988)
- Test: `ingestion/tests/test_tree_builder.py`, `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: `TableCell.ocr_recovered` (Task 2), `WarningKind.OCR_RECOVERED_TABLE_TEXT` (Task 4).
- Produces: nothing new consumed elsewhere — this is the terminal bridging step; the resulting `IntegrityWarning`s flow to the frontend generically via `CollapsibleWarnings.tsx` (no frontend code change needed, per this codebase's own established "new WarningKind, zero frontend change" convention — confirmed in the approved spec).

- [ ] **Step 1: Write the failing BASELINE tests**

Add to `ingestion/tests/test_tree_builder.py` (add `WarningKind` import if not already present — it already is, per the file's existing import block):

```python
def test_table_with_an_ocr_recovered_cell_emits_a_warning_attributed_to_the_open_node() -> None:
    path = "table_ocr.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19)),
            Block(id="b1", kind=BlockKind.HEADING, heading_level=2, text="Variant Table", source_ref=_sr(path, 20, 33)),
        ],
        tables=[
            Table(
                id="t0",
                cells=[[TableCell(text="Label", ocr_recovered=True), TableCell(text="Alpha")]],
                source_ref=_sr(path, 34, 35),
            )
        ],
    )
    tree = build_baseline_tree(doc)
    parent = next(n for n in tree.nodes if n.title == "Variant Table")
    assert len(tree.warnings) == 1
    assert tree.warnings[0].kind == WarningKind.OCR_RECOVERED_TABLE_TEXT
    assert tree.warnings[0].node_ids == [parent.local_id]
    assert tree.warnings[0].detail == {"tableId": "t0", "recoveredCellCount": 1}


def test_table_with_no_ocr_recovered_cells_emits_no_warning() -> None:
    path = "table_no_ocr.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 0, 19))],
        tables=[Table(id="t0", cells=[[TableCell(text="Rail"), TableCell(text="Voltage")]], source_ref=_sr(path, 20, 21))],
    )
    tree = build_baseline_tree(doc)
    assert tree.warnings == []


def test_an_orphaned_table_with_an_ocr_recovered_cell_emits_a_warning_with_no_node_ids() -> None:
    path = "orphan_table_ocr.docx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.DOCX, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution", source_ref=_sr(path, 20, 39))],
        tables=[Table(id="t0", cells=[[TableCell(text="Label", ocr_recovered=True)]], source_ref=_sr(path, 0, 1))],
    )
    tree = build_baseline_tree(doc)
    ocr_warnings = [w for w in tree.warnings if w.kind == WarningKind.OCR_RECOVERED_TABLE_TEXT]
    assert len(ocr_warnings) == 1
    assert ocr_warnings[0].node_ids == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_tree_builder.py -v -k ocr_recovered`
Expected: `test_table_with_an_ocr_recovered_cell_emits_a_warning_attributed_to_the_open_node` and the orphan-table test FAIL (`assert len(tree.warnings) == 1` finds 0); `test_table_with_no_ocr_recovered_cells_emits_no_warning` already PASSES today (no code path emits this warning yet) — that's expected, it's a regression guard, not a new-behavior proof.

- [ ] **Step 3: Implement the BASELINE bridge**

In `ingestion/app/leveling/tree_builder.py`, add this helper near `_table_to_html` (same file, same section — check that function's exact location and place the new one adjacent to it):

```python
def _ocr_recovered_table_warning(table: Table, node_ids: list[str]) -> IntegrityWarning | None:
    """One warning for this table if it has any OCR-recovered cell
    (TableCell.ocr_recovered, set by pdf_loader.py's _cell_ocr_recovery),
    None otherwise -- called once per table at its single BASELINE fold
    site below (each table is only ever folded once, unlike SURVEY's
    _ocr_recovered_table_warnings, which scans a whole branch's table list
    at once; see that function's own docstring for why the shapes differ)."""
    recovered_count = sum(1 for row in table.cells for cell in row if cell is not None and cell.ocr_recovered)
    if recovered_count == 0:
        return None
    return IntegrityWarning.make(
        WarningKind.OCR_RECOVERED_TABLE_TEXT,
        f"Table {table.id} had {recovered_count} cell(s) whose text could not be extracted directly "
        "and was recovered via OCR -- please spot-check against the source document.",
        node_ids=node_ids,
        detail={"tableId": table.id, "recoveredCellCount": recovered_count},
    )
```

Then change the `if table is not None:` branch (currently ~lines 858-883) to compute and append this warning in both the open-node and orphan cases:

```python
        for _, block, table in merged:
            if table is not None:
                description = _table_to_html(table)
                if not description.strip():
                    continue
                if stack:
                    open_node = nodes_by_id[stack[-1][1]]
                    open_node.description = assemble_description(open_node.description, description)
                    open_node.fidelity_hash = _hash_description(open_node.description)
                    open_node.identity_hash = _hash_identity(open_node.description, open_node.source_ref)
                    open_node.source_ref = _widen_page_end(open_node.source_ref, table.source_ref)
                    open_node.table_ids.append(table.id)
                    ocr_warning = _ocr_recovered_table_warning(table, node_ids=[open_node.local_id])
                else:
                    if orphan_source_ref is None:
                        orphan_source_ref = table.source_ref
                    orphan_entries.append(description)
                    title_preview = table.caption or "an untitled table"
                    warnings.append(
                        IntegrityWarning.make(
                            WarningKind.FRONT_MATTER_FOLDED,
                            f"A table ({title_preview}) precedes any heading/numbering in its "
                            f"branch -- folded into a synthetic front-matter node instead of being dropped.",
                            detail={"kind": "table", "sourceId": table.id, "preview": title_preview},
                        )
                    )
                    ocr_warning = _ocr_recovered_table_warning(table, node_ids=[])
                if ocr_warning is not None:
                    warnings.append(ocr_warning)
                continue
```

(Only the 2 new lines computing/appending `ocr_warning` are added to each branch, plus the shared `if ocr_warning is not None:` check before the existing `continue` — every other line in this block is unchanged from today.)

- [ ] **Step 4: Run BASELINE tests to verify they pass**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_tree_builder.py -v`
Expected: all PASS, including every pre-existing table test (all of which use plain `TableCell(text=c)` with `ocr_recovered` defaulting to `False`, so `recovered_count` is always 0 for them and `_ocr_recovered_table_warning` returns `None` — zero behavior change).

- [ ] **Step 5: Write the failing SURVEY tests**

Add to `ingestion/tests/test_llm_leveling.py` (near `test_unsupported_content_warnings_emits_one_warning_per_distinct_diagnostic_note`/`test_unsupported_content_warnings_is_empty_without_any_matching_note`, which this directly mirrors — check that file's exact `_unsupported_content_warnings` test pair for the precise construction/import style before writing these, since `llm_leveling.py`'s branch-level tests typically build a `Table`/`Block` list directly and call the internal function under test, not the whole `build_survey_tree` pipeline):

```python
def test_ocr_recovered_table_warnings_emits_one_warning_per_table_with_a_recovered_cell() -> None:
    tables = [
        Table(id="t0", cells=[[TableCell(text="Label", ocr_recovered=True), TableCell(text="Alpha")]], source_ref=_sr("x", 0, 1)),
        Table(id="t1", cells=[[TableCell(text="Rail"), TableCell(text="Voltage")]], source_ref=_sr("x", 1, 2)),
        Table(
            id="t2",
            cells=[[TableCell(text="A", ocr_recovered=True), TableCell(text="B", ocr_recovered=True)]],
            source_ref=_sr("x", 2, 3),
        ),
    ]
    warnings = _ocr_recovered_table_warnings(tables, section_label="Variants")
    assert len(warnings) == 2
    by_table_id = {w.detail["tableId"]: w for w in warnings}
    assert by_table_id["t0"].kind == WarningKind.OCR_RECOVERED_TABLE_TEXT
    assert by_table_id["t0"].detail["recoveredCellCount"] == 1
    assert by_table_id["t2"].detail["recoveredCellCount"] == 2
    assert "t1" not in by_table_id


def test_ocr_recovered_table_warnings_is_empty_without_any_recovered_cell() -> None:
    tables = [Table(id="t0", cells=[[TableCell(text="Rail"), TableCell(text="Voltage")]], source_ref=_sr("x", 0, 1))]
    assert _ocr_recovered_table_warnings(tables, section_label=None) == []
```

(Check `test_llm_leveling.py`'s existing `_sr` helper — it should already exist, matching `test_tree_builder.py`'s own `_sr(path, start, end)` shape; if this file names it differently, use the existing name instead of inventing a duplicate.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_llm_leveling.py -v -k ocr_recovered_table_warnings`
Expected: both FAIL with `ImportError`/`NameError` — `_ocr_recovered_table_warnings` does not exist yet.

- [ ] **Step 7: Implement the SURVEY bridge**

In `ingestion/app/leveling/llm_leveling.py`, add this function immediately after `_unsupported_content_warnings` (which it directly mirrors):

```python
def _ocr_recovered_table_warnings(tables: list[Table] | None, section_label: str | None) -> list[IntegrityWarning]:
    """One warning per table in this branch with 1+ OCR-recovered cell
    (TableCell.ocr_recovered, set by pdf_loader.py's _cell_ocr_recovery) --
    one warning per TABLE, not per cell, same "don't spam the warnings
    list" convention as _unsupported_content_warnings/
    _referenced_attachment_warnings just above. Scans the whole branch's
    table list at once (unlike tree_builder.py's BASELINE counterpart,
    _ocr_recovered_table_warning, which checks one table at a time inline
    at its single table-fold site) because this function is called once
    per branch at the very end of branch analysis, mirroring where
    _unsupported_content_warnings/_referenced_attachment_warnings are
    already called (see this function's own call site)."""
    section_ref = f'The "{section_label}" section' if section_label else "This section"
    out: list[IntegrityWarning] = []
    for table in tables or []:
        recovered_count = sum(1 for row in table.cells for cell in row if cell is not None and cell.ocr_recovered)
        if recovered_count == 0:
            continue
        out.append(
            IntegrityWarning.make(
                WarningKind.OCR_RECOVERED_TABLE_TEXT,
                f"{section_ref} contains a table ({table.id}) with {recovered_count} cell(s) whose text "
                "could not be extracted directly and was recovered via OCR -- please spot-check against "
                "the source document.",
                detail={"section": section_label or "(root)", "tableId": table.id, "recoveredCellCount": recovered_count},
            )
        )
    return out
```

Add its call at the existing call site (currently `warnings.extend(_unsupported_content_warnings(blocks, section_label))`, immediately followed by the `return _BranchSkeleton(...)` statement):

```python
    warnings.extend(_referenced_attachment_warnings(section_text, section_label))
    warnings.extend(_unsupported_content_warnings(blocks, section_label))
    warnings.extend(_ocr_recovered_table_warnings(tables, section_label))
```

- [ ] **Step 8: Run SURVEY tests to verify they pass**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_llm_leveling.py -v -k ocr_recovered`
Expected: both PASS.

- [ ] **Step 9: Run the full ingestion suite to confirm no regression**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/ -q`
Expected: baseline pass count (1436 passed, 1 pre-existing unrelated failure) plus this task's 5 new tests, all passing.

- [ ] **Step 10: Commit**

```bash
git add ingestion/app/leveling/tree_builder.py ingestion/app/leveling/llm_leveling.py ingestion/tests/test_tree_builder.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(ingestion): bridge TableCell.ocr_recovered into IntegrityWarning

BASELINE (tree_builder.py) and SURVEY (llm_leveling.py) each get their own
bridging helper, one warning per table with any recovered cell -- the
last piece connecting pdf_loader.py's ingest-time OCR recovery to a real,
reviewer-visible WorkItemTree warning."
```

---

## Task 8: Integration test, regression test, and the full-suite regression gate

**Files:**
- Create: `ingestion/tests/fixtures/build_table_ocr_fixture.py`
- Create: `ingestion/tests/fixtures/table_with_image_header.pdf` (generated, checked in — same convention as `scanned_sample.pdf`)
- Create: `ingestion/tests/fixtures/build_table_blank_cell_fixture.py`
- Create: `ingestion/tests/fixtures/table_with_blank_cell.pdf` (generated, checked in)
- Modify: `ingestion/tests/test_pdf_loader.py` (remove the `@pytest.mark.skip` added in Task 6, add the integration + regression tests)
- Modify: `ingestion/tests/test_tree_builder.py` (one end-to-end test: real fixture through `load_pdf` + `build_baseline_tree`)

**Interfaces:**
- Consumes: everything from Tasks 1-7. This is the final task — no later task depends on it.

- [ ] **Step 1: Write and run the fixture generators**

Create `ingestion/tests/fixtures/build_table_ocr_fixture.py`:

```python
"""Run once to (re)generate table_with_image_header.pdf:
`python build_table_ocr_fixture.py`.

Produces a PDF with one ruled table whose header row mixes a real-text
label ("ID") with one cell whose "text" is actually a small raster image
of the word "Label" -- mirroring cubeadcs_icd.pdf's real-world bug (a
table header authored as an embedded image, not font glyphs), confirmed
via direct pdfplumber inspection to produce the same signature: zero
page.chars in that cell's bbox despite the label being visibly present
when the page is rendered. The trailing data-row cell is intentionally
left blank (real geometry, genuinely empty) so the SAME fixture also
supports proving OCR recovery does not misfire on legitimate empty data
(see test_build_pdf_table_grid_calls_ocr_recovery_only_for_empty_text_cells
in test_pdf_loader.py, and the dedicated blank-cell fixture/regression
test in build_table_blank_cell_fixture.py for the OCR-never-called case).
"""
from pathlib import Path

from PIL import Image as PILImage, ImageDraw
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
from reportlab.platypus.flowables import Image as RLImage

fixtures_dir = Path(__file__).parent
label_image_path = fixtures_dir / "_header_label.png"
out_path = fixtures_dir / "table_with_image_header.pdf"

img = PILImage.new("RGB", (200, 40), color="white")
draw = ImageDraw.Draw(img)
draw.text((10, 10), "Label", fill="black")
img.save(label_image_path)

data = [
    ["ID", RLImage(str(label_image_path), width=100, height=20)],
    ["1", "Alpha"],
    ["2", ""],
]
table = Table(data, colWidths=[100, 150])
table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 1, colors.black)]))

doc = SimpleDocTemplate(str(out_path), pagesize=letter)
doc.build([table])

label_image_path.unlink()
print(f"wrote {out_path}")
```

Create `ingestion/tests/fixtures/build_table_blank_cell_fixture.py`:

```python
"""Run once to (re)generate table_with_blank_cell.pdf:
`python build_table_blank_cell_fixture.py`.

Produces a PDF with one ruled table, every cell real text EXCEPT one
genuinely blank data cell (real geometry, no image, no text) -- proves
OCR recovery must never fire for legitimate empty data (see
test_table_ocr_recovery_never_calls_ocr_for_a_genuinely_blank_cell in
test_pdf_loader.py). Kept as its own minimal fixture, separate from
table_with_image_header.pdf, so this regression property is provable
without any interaction with that fixture's real (mocked-out) OCR call.
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle

fixtures_dir = Path(__file__).parent
out_path = fixtures_dir / "table_with_blank_cell.pdf"

data = [
    ["ID", "Name"],
    ["1", "Alpha"],
    ["2", ""],
]
table = Table(data, colWidths=[100, 150])
table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 1, colors.black)]))

doc = SimpleDocTemplate(str(out_path), pagesize=letter)
doc.build([table])

print(f"wrote {out_path}")
```

Run both:
```bash
cd ingestion && source .venv/bin/activate
python tests/fixtures/build_table_ocr_fixture.py
python tests/fixtures/build_table_blank_cell_fixture.py
```
Expected: both print `wrote .../ingestion/tests/fixtures/<name>.pdf`, and both `.pdf` files now exist on disk (git status shows them as untracked, ready to be added in this task's commit).

Now remove the `@pytest.mark.skip(...)` decorator from `test_build_pdf_table_grid_calls_ocr_recovery_only_for_empty_text_cells` (added in Task 6, Step 1) in `ingestion/tests/test_pdf_loader.py` — `table_with_blank_cell.pdf` now exists.

- [ ] **Step 2: Run the un-skipped Task 6 test to verify it now passes for real**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py -v -k calls_ocr_recovery_only_for_empty`
Expected: PASS (no longer skipped).

- [ ] **Step 3: Write the failing integration + regression tests**

Add to `ingestion/tests/test_pdf_loader.py`:

```python
def test_table_ocr_recovery_recovers_an_image_only_header_cell_end_to_end() -> None:
    # Real pytesseract call, no mocking -- proves the whole path (render,
    # inset crop, pre-check, OCR, confidence filter, write-back,
    # ocr_recovered flag) works together against a real PDF, the way
    # cubeadcs_icd.pdf's real header cells needed it to.
    doc = load_pdf(str(FIXTURES / "table_with_image_header.pdf"))
    assert len(doc.tables) == 1
    header_cell = doc.tables[0].cells[0][1]
    assert header_cell is not None
    assert "Label" in header_cell.text
    assert header_cell.ocr_recovered is True

    # The same fixture's other empty-text cell (row 2, col 1) has no image
    # behind it at all -- genuinely blank, must be left alone even though
    # it hit the identical "empty extracted text" code path as the
    # recovered cell above.
    blank_cell = doc.tables[0].cells[2][1]
    assert blank_cell is not None
    assert blank_cell.text == ""
    assert blank_cell.ocr_recovered is False


def test_table_ocr_recovery_never_calls_ocr_for_a_genuinely_blank_cell() -> None:
    from unittest.mock import patch

    # A dedicated fixture with ONLY a genuinely blank cell (no embedded
    # image anywhere) -- the mock raises if the pre-check ever lets a real
    # OCR call through for it, proving the inset+stddev pre-check (Task 5)
    # actually skips real blank cells rather than merely returning "" after
    # a wasted real OCR attempt.
    with patch(
        "app.loaders.pdf_loader.pytesseract.image_to_data",
        side_effect=AssertionError("OCR must never be called for a genuinely blank cell"),
    ):
        doc = load_pdf(str(FIXTURES / "table_with_blank_cell.pdf"))
    blank_cell = doc.tables[0].cells[2][1]
    assert blank_cell is not None
    assert blank_cell.text == ""
    assert blank_cell.ocr_recovered is False
```

Add to `ingestion/tests/test_tree_builder.py`:

```python
def test_a_real_ocr_recovered_pdf_table_produces_the_expected_warning_end_to_end() -> None:
    from pathlib import Path

    from app.leveling.tree_builder import build_baseline_tree
    from app.loaders.pdf_loader import load_pdf

    fixtures_dir = Path(__file__).parent / "fixtures"
    doc = load_pdf(str(fixtures_dir / "table_with_image_header.pdf"))
    tree = build_baseline_tree(doc)
    ocr_warnings = [w for w in tree.warnings if w.kind == WarningKind.OCR_RECOVERED_TABLE_TEXT]
    assert len(ocr_warnings) == 1
    assert ocr_warnings[0].detail["tableId"] == doc.tables[0].id
    assert ocr_warnings[0].detail["recoveredCellCount"] == 1
```

- [ ] **Step 4: Run tests to verify they fail (or pass, for the pre-existing-behavior checks) as expected**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py tests/test_tree_builder.py -v -k "ocr_recovery or ocr_recovered"`
Expected: `test_table_ocr_recovery_recovers_an_image_only_header_cell_end_to_end` and `test_a_real_ocr_recovered_pdf_table_produces_the_expected_warning_end_to_end` FAIL until Tasks 1-7 are all in place (they should already be, if tasks ran in order — if this task is reached first with earlier tasks incomplete, these fail for the right reason: no recovery happens yet). `test_table_ocr_recovery_never_calls_ocr_for_a_genuinely_blank_cell` should already PASS once Task 5's pre-check is in place (this is confirming, not introducing, correct behavior).

- [ ] **Step 5: Run the full task-relevant suite to confirm everything passes together**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/test_pdf_loader.py tests/test_tree_builder.py tests/test_llm_leveling.py tests/test_ocr.py tests/test_schema_conformance.py tests/test_worktree_schema_conformance.py -v`
Expected: all PASS.

- [ ] **Step 6: THE FULL-SUITE REGRESSION GATE (required, not optional)**

Run: `cd ingestion && source .venv/bin/activate && pytest tests/ -q 2>&1 | tail -30`

Compare the final summary line against today's known baseline: **1436 passed, 1 pre-existing/order-dependent-flaky unrelated failure (`test_ingest_survey_mode_still_captions_when_vision_is_configured`)**. Expected new total: `1436 + (this plan's new test count)` passed, same 1 pre-existing failure, 0 new failures.

Then specifically re-run and read the output of every figure/vision-related test file, confirming zero changed assertions (this is the spec's own named "must not touch figure processing" requirement):

```bash
pytest tests/test_orchestrator_vision_client.py tests/test_ingest_caption_status.py -v
pytest tests/test_pdf_loader.py -v -k "figure or degenerate or vision"
pytest tests/test_docx_loader.py tests/test_pptx_loader.py -v -k "figure or degenerate"
```

Expected: every one of these PASSES with the exact same test names/count as before this plan started (confirm via `git stash` + re-run + `git stash pop` if there is ANY doubt about whether this plan's changes affected these files — they should not have touched any of them at all; `git diff --stat` against this plan's own commits should show zero lines changed in `orchestrator_vision_client.py`, `narration_publisher.py`, `main.py`'s figure-caption cache code, or any `_is_degenerate_*` function).

- [ ] **Step 7: Commit**

```bash
git add ingestion/tests/fixtures/build_table_ocr_fixture.py ingestion/tests/fixtures/table_with_image_header.pdf \
        ingestion/tests/fixtures/build_table_blank_cell_fixture.py ingestion/tests/fixtures/table_with_blank_cell.pdf \
        ingestion/tests/test_pdf_loader.py ingestion/tests/test_tree_builder.py
git commit -m "test(ingestion): end-to-end table-cell OCR recovery integration + regression tests

Real pytesseract call (no mocking) proves the full path against a
synthetic PDF reproducing cubeadcs_icd.pdf's real-world header-as-image
bug; a second, dedicated blank-cell fixture proves recovery never
misfires on genuinely empty data (zero OCR calls, mocked to fail the
test if invoked). Full-suite regression gate confirmed: baseline pass
count preserved, zero changed figure/vision test assertions."
```

---

## Self-Review

**Spec coverage:**
- Trigger scope (any blank cell, not header-only): Task 6's wiring checks `if not text.strip()` unconditionally for every grid position, not gated on `is_header`. ✅
- Always on, no new flag: no new env var, settings field, or request parameter introduced anywhere in this plan; `languages` reuses the existing request-level value (Task 1 just closes the plumbing gap). ✅
- Flag for review via new WarningKind, one per table: Task 4 + Task 7. ✅
- PDF-only: nothing in this plan touches `docx_loader.py`/`pptx_loader.py`/`xlsx_loader.py`. ✅
- Cheap pre-check before OCR: Task 5's `_cell_ocr_recovery`, with the inset fix this plan's own empirical check surfaced. ✅
- OCR via the same confidence-filtered logic, extracted into a shared helper: Task 3. ✅
- `languages` parameter, no new request parameter: Task 1. ✅
- Whole-page render, cached per page, cropped: Task 5's `page_image_cache` + `_TABLE_OCR_RENDER_DPI`. ✅
- Rejected alternative (embedded-image-object correlation): not implemented, consistent with the spec's own rejection — no task attempts it. ✅
- Regression safety (touches only table code, new cache separate from `cached_pdf_reader`, full-suite gate): Global Constraints + Task 8 Step 6. ✅
- Unit tests (a)-(d): Task 5 Steps 1 (pre-check skip, scaled/inset crop, empty-result fail-open) + Task 8 Step 3 (non-empty OCR output writes recovered text and reflects in the table's warning, proven end-to-end). ✅
- Integration test with synthetic PDF fixture: Task 8. ✅
- Regression test (genuinely blank cell untouched, no OCR call): Task 8. ✅
- Existing whole-page OCR fallback tests unaffected: Task 3 is a behavior-preserving refactor, verified by every pre-existing `ocr_page_to_text_filtered`/`test_ocr.py` test continuing to pass unchanged. ✅
- `shared/ts` regeneration + `generated.spec.ts` pass in the same commit as the schema change: Task 4 Step 4/7. ✅

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" phrasing found in any step above; every code block is complete, runnable code with concrete values (DPI 200, inset 2.0pt, threshold 5.0, confidence 30 unchanged).

**Type consistency:** `_cell_ocr_recovery`'s signature (Task 5) and its call site inside `_build_pdf_table_grid` (Task 6) use identical parameter names and order throughout (`path, page_index, bbox, languages, page_image_cache`). `_build_pdf_table_grid`'s widened signature (Task 6) matches its call site in `load_pdf` exactly (`path=path, page_index=page_number - 1, languages=languages, page_image_cache=page_image_cache`). `_ocr_recovered_table_warning` (BASELINE, singular, Task 7) and `_ocr_recovered_table_warnings` (SURVEY, plural, Task 7) are deliberately differently-shaped (one-table-at-a-time inline vs. whole-branch-at-once) — this asymmetry is explained in both functions' own docstrings and mirrors the existing `UNSUPPORTED_CONTENT_NOTE` precedent exactly (inline check in `tree_builder.py`, whole-list scan in `llm_leveling.py`), not an inconsistency.

---

## Verification (full plan)

- `cd ingestion && source .venv/bin/activate && pytest tests/ -q` — full suite, diffed against the 1436-passed/1-pre-existing-failure baseline (Task 8, Step 6).
- `cd shared/ts && pnpm generate && pnpm test` — schema/TS drift guard (Task 4).
- No orchestrator or frontend changes in this plan — `npm test` in those packages is unaffected and not required to re-run, though running them costs nothing and is a reasonable final sanity check if time permits.
- End-to-end (optional, matches this repo's own established pattern for user-visible features): re-run the CubeADCS ICD (`cubeadcs_icd.pdf`) through a real SURVEY or BASELINE job via Playwright MCP once this plan lands, and confirm the "Summary of CubeADCS Variants" table (page 14) now shows real header labels instead of blank/unreadable cells, with a corresponding "OCR-recovered" warning visible in the warnings panel.
