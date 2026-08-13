# PDF Ingestion Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix PDF ingestion's root-cause segmentation bug (every page collapses to one paragraph block today) and build heading/table/form/multi-column fidelity on top of it, plus a whole-document AI context primer that generalizes Task 11's glossary-inlining across every format.

**Architecture:** Two services. `ingestion/app/loaders/pdf_loader.py` (Python) gets a sequenced rewrite — line-level segmentation and header/footer suppression must land together (Task 2), then heading detection (Task 3) builds on that, then table/form/column fidelity (Tasks 5-9) are independent additions. The orchestrator (TypeScript) gets a new whole-document primer capability (Tasks 10-12) that uploads the raw file to Open WebUI, grounds one chat completion in "Using Entire Document" mode, and threads the result into `/level` as a plain string — following the exact `*_client`-optional convention `llm_leveling.py` already uses everywhere else.

**Tech Stack:** Python 3.11+, pdfplumber 0.11.10, pypdf 6.14.2 (ingestion); TypeScript/NestJS, the OpenAI SDK client already wired in `openwebui.client.ts`, `ioredis` (orchestrator); pytest / Jest for tests.

## Global Constraints

- Run ingestion tests via `cd ingestion && .venv/bin/python -m pytest tests/<file>.py -v`.
- Run orchestrator tests via `cd orchestrator && npm test -- <file>.spec.ts` (Jest).
- No change to `app/canonical/model.py` — every field this plan uses (`Block.number_label`, `BlockKind.LIST_ITEM`/`NOTE`, `Table.caption`) already exists.
- No change to `docx_loader.py`/`pptx_loader.py`/any non-PDF loader — Phase 2's heading-number synthesis is reimplemented locally in `pdf_loader.py`, not extracted into a shared module, even though it duplicates docx's already-validated algorithm — a cross-loader refactor is out of scope for this spec.
- Every new detection/extraction path must degrade gracefully — never abort the whole document load. A field or block that can't be confidently classified falls through to today's plain `PARAGRAPH`/no-marker behavior, never raises.
- Task 2 (Phase 0+1) is one task, not two — shipping line segmentation without header/footer suppression in the same change is documented as actively worse than today (a footer becomes a real depth-1 branch boundary).
- Every optional new capability in `llm_leveling.py`/`build_survey_tree` follows the existing `*_client`/`*_context: str | None = None`-default convention — `None` must be byte-identical to before the capability existed.
- Phase 6 (Tasks 10-12) must not touch `docs/architecture.md`'s locked redact-first decision for any OTHER existing call (`chat()`/`embed()`/`vision()`) — the new upload path is additive, gated by the same `LLM_TRUSTED_LOCAL` flag those calls already read.

---

## Task 1: Fix OCR path dropping every `Figure`

**Files:**
- Modify: `ingestion/app/loaders/ocr.py:103`
- Test: `ingestion/tests/test_pdf_loader.py` (or a new `ingestion/tests/test_ocr.py` if one doesn't already exist — check first)

**Interfaces:**
- Consumes: nothing new — `load_pdf` (existing) already returns `CanonicalDoc.figures` correctly for text-bearing pages.
- Produces: no new function — `load_pdf_with_ocr_fallback`'s return value now includes `figures`.

`load_pdf_with_ocr_fallback` (`ocr.py:57-103`) calls `text_doc = load_pdf(path, describe_figure=describe_figure)` at line 71 to get every text-bearing page's blocks/tables/figures, then constructs the final `CanonicalDoc` at line 103 with `blocks=blocks, tables=text_doc.tables` — omitting `figures=`. Every `.pdf` routes through this function (`dispatch.py:78`), so any PDF with at least one non-text page silently loses every `Figure` object from its text-bearing pages too, even though the `FIGURE`-kind `Block`s survive in `blocks`.

- [ ] **Step 1: Write the failing test**

Check first whether `ingestion/tests/test_pdf_loader.py` already has an OCR-fallback figure test (search for `load_pdf_with_ocr_fallback` and `figures` in that file). If not, add:

```python
def test_load_pdf_with_ocr_fallback_preserves_figures_from_text_pages() -> None:
    # Regression: load_pdf_with_ocr_fallback's final CanonicalDoc construction
    # omitted figures= entirely -- any PDF with at least one non-text page
    # silently lost every Figure object from its TEXT-bearing pages too,
    # even though the FIGURE-kind Block survived in `blocks`.
    from app.loaders.ocr import load_pdf_with_ocr_fallback

    # tests/fixtures/pdf_with_figure.pdf has a real embedded image on a
    # text-bearing page (see build_pdf_with_figure_fixture.py); mixed with
    # a scanned page forces the OCR-fallback path to fire at all.
    doc = load_pdf_with_ocr_fallback(str(FIXTURES / "pdf_with_figure.pdf"))
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) >= 1
    assert len(doc.figures) == len(figure_blocks)
```

Note: `pdf_with_figure.pdf` (per its own fixture builder) has no scanned page, so `load_pdf_with_ocr_fallback` would take the `not any_scanned` early-return at line 64-65 (`return load_pdf(...)` directly) — which is ALREADY correct (no bug there, `load_pdf` on its own returns figures fine). To exercise the actual buggy code path (the `figures=` omission at line 103), the test needs a document that's a MIX of a text page with a figure AND at least one scanned page, so `any_scanned` is `True` and the buggy branch (lines 67-103) actually runs. Build one:

```python
def _build_mixed_text_and_scanned_pdf_with_figure(tmp_path: Path) -> Path:
    # A text-bearing page with a real embedded image (exercises load_pdf's
    # own figure extraction, called via text_doc = load_pdf(...) inside
    # load_pdf_with_ocr_fallback) followed by an image-only scanned page
    # (forces any_scanned=True so the buggy branch at ocr.py:67-103 runs).
    from docx import Document as _unused  # not used -- placeholder import removed below
```

Actually, simpler and more direct — build via `pypdf`/`reportlab` merging the existing fixtures' pages, or construct fresh with reportlab directly:

```python
def _build_mixed_text_and_scanned_pdf_with_figure(tmp_path: Path) -> Path:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    from PIL import Image

    text_page_path = tmp_path / "text_page.pdf"
    c = rl_canvas.Canvas(str(text_page_path), pagesize=letter)
    c.drawString(72, 700, "A text-bearing page with an embedded figure.")
    image_path = tmp_path / "fig.png"
    Image.new("RGB", (10, 10), color="blue").save(image_path)
    c.drawImage(str(image_path), 72, 500, width=50, height=50)
    c.save()

    scanned_page_path = tmp_path / "scanned_page.pdf"
    scan_image_path = tmp_path / "scan.png"
    Image.new("RGB", (200, 200), color="white").save(scan_image_path)
    c2 = rl_canvas.Canvas(str(scanned_page_path), pagesize=letter)
    c2.drawImage(str(scan_image_path), 0, 0, width=letter[0], height=letter[1])
    c2.save()

    from pypdf import PdfWriter, PdfReader
    writer = PdfWriter()
    for p in (text_page_path, scanned_page_path):
        reader = PdfReader(str(p))
        writer.add_page(reader.pages[0])
    out_path = tmp_path / "mixed.pdf"
    with open(out_path, "wb") as f:
        writer.write(f)
    return out_path


def test_load_pdf_with_ocr_fallback_preserves_figures_from_text_pages(tmp_path: Path) -> None:
    # Regression: load_pdf_with_ocr_fallback's final CanonicalDoc construction
    # (ocr.py:103) omitted figures= entirely -- any PDF with at least one
    # non-text page silently lost every Figure object extracted from its
    # TEXT-bearing pages too, even though the FIGURE-kind Block survived.
    from app.loaders.ocr import load_pdf_with_ocr_fallback

    path = _build_mixed_text_and_scanned_pdf_with_figure(tmp_path)
    doc = load_pdf_with_ocr_fallback(str(path))

    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1
    assert len(doc.figures) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -k "preserves_figures_from_text_pages" -v`
Expected: FAIL — `len(doc.figures) == 0`, not `1`.

- [ ] **Step 3: Implement the fix**

In `ocr.py:103`, change:

```python
    return CanonicalDoc(document=document, blocks=blocks, tables=text_doc.tables)
```

to:

```python
    return CanonicalDoc(document=document, blocks=blocks, tables=text_doc.tables, figures=text_doc.figures)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -v`
Expected: all PASS, including the new test.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/ocr.py ingestion/tests/test_pdf_loader.py
git commit -m "fix(ocr): preserve Figure objects from text-bearing pages in OCR-fallback path"
```

---

## Task 2: Phase 0+1 — line-level segmentation + header/footer suppression

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (`load_pdf`, `~lines 495-723`; removes `_paragraph_tops`, `~lines 478-492`)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: pdfplumber's `page.extract_text_lines()` (confirmed real API, returns `list[dict]` with `text`/`x0`/`top`/`x1`/`bottom`/`chars`, each char carrying `size`/`fontname` — verified live this session).
- Produces: `_lines_to_paragraphs(lines: list[dict]) -> list[tuple[str, float]]` (module-level function, returns `(paragraph_text, top)` pairs — replaces `_paragraph_tops`/the `text.split("\n\n")` call together). `_is_running_boilerplate(candidate_text: str, page_index: int, all_pages_first_or_last_lines: dict[int, list[str]]) -> bool` is NOT built in this task — header/footer detection needs the FULL per-page line list across the WHOLE document (to check recurrence across pages), so it's implemented as a second pass inside `load_pdf` itself, described below, not a separate importable function. Task 3 (heading detection) consumes `_lines_to_paragraphs`'s output shape indirectly — it doesn't call this function directly, but relies on the fact that `load_pdf`'s main loop now iterates real per-line text with real font metadata available, not opaque page-blobs.

### Why this must be one task, not two

Verified: `parse_numbering("2 | P a ge")` → `("2", "| P a ge")` → depth 1. Once real per-line blocks exist but before footers are suppressed, every page footer becomes a **top-level branch boundary** for `_split_into_branches`. Shipping line segmentation alone would make PDF branching *worse* than today's single-fallback-branch case.

### Segmentation algorithm

Real, measured line-gap data (LVC Gateway ICD, page 5, 11.04pt body font): within-paragraph wrapped-line gaps are ~3.4-3.6pt; paragraph/section breaks are 19-56pt, or a font-size change. Threshold: merge two consecutive lines into the same paragraph when their font sizes match within tolerance AND the gap between them is small relative to that font size.

```python
# Added near the top of pdf_loader.py, alongside the other tuned-threshold
# constants (_ALIGNMENT_CENTER_BAND, _BACKGROUND_OVERLAP_THRESHOLD).
#
# Real, measured gap data (LVC Gateway ICD, an 11.04pt-body real government
# ICD): within-paragraph wrapped-line gaps are ~3.4-3.6pt; a paragraph or
# section break is 19pt+ or accompanied by a font-size change. 0.5x the
# line's own font size comfortably covers the observed within-paragraph
# band (5.5pt at 11pt) while rejecting every observed break (19pt+) with
# wide margin -- not derived from a formal study, a defensible threshold
# from real measurement, same convention as this file's other heuristic
# constants.
_PARAGRAPH_LINE_GAP_RATIO = 0.5

# Two lines' font sizes are "the same" within this many points -- guards
# against pdfplumber's own float sub-pixel noise (confirmed live: the same
# nominal 11.04pt size can come back as 11.039999999999964 vs
# 11.03999999999996 across different chars/lines of the same document).
_PARAGRAPH_LINE_SIZE_TOLERANCE = 0.1


def _line_size(line: dict) -> float:
    """A line's representative font size -- the first non-empty char's
    `size`, same 'first non-whitespace wins' convention this file's own
    `_cell_text_color` already uses for the identical "no safe single
    answer when characters could disagree" situation. A line with no
    chars at all (shouldn't happen for a real extract_text_lines() result,
    but degrade rather than raise) returns 0.0 -- a heading/body comparison
    against 0.0 always fails the "is an outlier" test, which is the safe
    direction (falls through to PARAGRAPH, never wrongly promoted)."""
    for ch in line.get("chars", []):
        if (ch.get("text") or "").strip():
            return ch["size"]
    return 0.0


def _line_is_bold(line: dict) -> bool:
    """Same 'first non-whitespace char wins' convention as `_line_size`,
    reusing this file's existing `_fontname_is_bold`."""
    for ch in line.get("chars", []):
        if (ch.get("text") or "").strip():
            return _fontname_is_bold(ch.get("fontname"))
    return False


def _lines_to_paragraphs(lines: list[dict]) -> list[tuple[str, float]]:
    """Merges pdfplumber's per-LINE extract_text_lines() output back into
    real paragraphs -- replaces the old, dead `text.split("\\n\\n")` (see
    this module's own load_pdf docstring for why that never actually
    split anything: extract_text() never emits a blank line, so every page
    became exactly one PARAGRAPH block). Adjacent lines merge into ONE
    paragraph when their font size matches (within
    _PARAGRAPH_LINE_SIZE_TOLERANCE) and the vertical gap between them is
    small relative to that size (_PARAGRAPH_LINE_GAP_RATIO) -- see this
    file's own constants for the real measured data behind these
    thresholds. Returns (paragraph_text, top) pairs -- `top` is the
    FIRST line's own top, for the same real-document-order merge
    load_pdf's main loop already does for tables/images."""
    if not lines:
        return []
    paragraphs: list[tuple[str, float]] = []
    current_texts = [lines[0]["text"]]
    current_top = lines[0]["top"]
    prev_bottom = lines[0]["bottom"]
    prev_size = _line_size(lines[0])
    for line in lines[1:]:
        size = _line_size(line)
        gap = line["top"] - prev_bottom
        same_size = abs(size - prev_size) <= _PARAGRAPH_LINE_SIZE_TOLERANCE
        small_gap = gap <= max(size, prev_size) * _PARAGRAPH_LINE_GAP_RATIO
        if same_size and small_gap:
            current_texts.append(line["text"])
        else:
            paragraphs.append((" ".join(current_texts), current_top))
            current_texts = [line["text"]]
            current_top = line["top"]
        prev_bottom = line["bottom"]
        prev_size = size
    paragraphs.append((" ".join(current_texts), current_top))
    return paragraphs
```

### Header/footer suppression algorithm

```python
import re

# Real measured pattern (LVC Gateway ICD): a footer's literal text varies
# ONLY in an embedded page number ("2 | P a ge", "4 | P a ge", same
# template) -- exact-string matching alone misses every footer. Digits are
# normalized to a placeholder before the recurrence check.
_DIGIT_RUN_PATTERN = re.compile(r"\d+")


def _normalize_digits(text: str) -> str:
    return _DIGIT_RUN_PATTERN.sub("#", text)


# A header/footer must recur on at least this fraction of pages to be
# suppressed -- verified real case (LVC Gateway ICD) recurs on 33/35
# (~94%); a fraction well below that (2/3, ~67%) still safely excludes a
# genuinely one-off repeated title appearing on just a couple of pages by
# coincidence, while catching the real running-header/footer case with
# comfortable margin.
_BOILERPLATE_RECURRENCE_FRACTION = 0.6
```

Inside `load_pdf`, this needs a **first pass over every page's lines** (before the existing table/image extraction loop) to collect each page's first and last line (candidate header/footer), then a recurrence check across the whole document, THEN the existing per-page loop drops any line matching a confirmed header/footer template.

- [ ] **Step 1: Write the failing tests**

```python
def test_load_pdf_merges_wrapped_lines_into_one_paragraph_block() -> None:
    # Regression: text.split("\n\n") never actually split anything (pdfplumber
    # never emits a blank line), so a multi-line wrapped paragraph and every
    # OTHER paragraph/heading on the page all became ONE giant PARAGRAPH block.
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "wrapped.pdf"
        styles = getSampleStyleSheet()
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        long_text = "This is a long sentence that must wrap across multiple lines when rendered at normal body width in a standard page layout. " * 3
        doc.build([
            Paragraph("Title Heading", styles["Title"]),
            Paragraph(long_text, styles["BodyText"]),
            Paragraph("A second, separate paragraph.", styles["BodyText"]),
        ])
        result = load_pdf(str(path))

    paragraph_blocks = [b for b in result.blocks if b.kind == BlockKind.PARAGRAPH]
    # Exactly 3 blocks: title, the wrapped long paragraph (merged back into
    # ONE block despite spanning multiple lines), and the second paragraph --
    # not 1 giant page-blob, and not one block PER LINE either.
    assert len(paragraph_blocks) == 3
    assert paragraph_blocks[1].text.startswith("This is a long sentence")
    assert paragraph_blocks[1].text.count("This is a long sentence") == 3  # all 3 repeats intact, still one block


def test_load_pdf_suppresses_a_running_header_recurring_across_most_pages() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "headered.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        for i in range(5):
            c.drawString(72, 750, "MY DOCUMENT - REV A")  # running header, every page
            c.drawString(72, 700, f"Body content unique to page {i}.")
            c.showPage()
        c.save()
        result = load_pdf(str(path))

    header_texts = [b.text for b in result.blocks if "REV A" in b.text]
    assert header_texts == []  # suppressed on every page, not surviving as a PARAGRAPH block
    body_texts = [b.text for b in result.blocks if "Body content unique" in b.text]
    assert len(body_texts) == 5  # unique body content on every page is untouched


def test_load_pdf_suppresses_a_footer_that_varies_only_by_page_number() -> None:
    # Regression: exact-string matching alone would miss this -- the real
    # footer text differs per page (embedded page number), same template.
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "footered.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        for i in range(5):
            c.drawString(72, 700, f"Body content unique to page {i}.")
            c.drawString(72, 40, f"{i + 1} | Page")  # footer, page number varies
            c.showPage()
        c.save()
        result = load_pdf(str(path))

    footer_texts = [b.text for b in result.blocks if "| Page" in b.text]
    assert footer_texts == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -k "merges_wrapped_lines or suppresses_a_running_header or suppresses_a_footer" -v`
Expected: all FAIL — the wrapped-paragraph test fails because the whole page is one block; the header/footer tests fail because the boilerplate text survives as ordinary `PARAGRAPH` blocks.

- [ ] **Step 3: Implement the fix**

Add the constants and three new functions (`_line_size`, `_line_is_bold`, `_lines_to_paragraphs`, `_normalize_digits`) shown above near the top of `pdf_loader.py`, alongside the existing threshold constants.

Add a new function for the header/footer recurrence pass:

```python
def _detect_boilerplate_templates(pages_first_lines: list[str], pages_last_lines: list[str]) -> tuple[set[str], set[str]]:
    """Returns (header_templates, footer_templates) -- the set of
    digit-normalized line templates that recur on at least
    _BOILERPLATE_RECURRENCE_FRACTION of pages, checked separately for the
    FIRST line (header candidate) and LAST line (footer candidate) of
    each page. Empty strings (a page with no lines at all) are never
    counted as boilerplate."""
    from collections import Counter

    def _templates(lines: list[str]) -> set[str]:
        normalized = [_normalize_digits(t) for t in lines if t]
        if not normalized:
            return set()
        counts = Counter(normalized)
        threshold = len(lines) * _BOILERPLATE_RECURRENCE_FRACTION
        return {template for template, count in counts.items() if count >= threshold}

    return _templates(pages_first_lines), _templates(pages_last_lines)
```

Now rewrite `load_pdf`'s body. Replace the existing per-page loop (`~lines 524-723`) — the structure changes from "one pass, filter+extract_text+split" to "two passes: collect lines for boilerplate detection, then process." Delete `_paragraph_tops` (`~lines 478-492`) entirely — `_lines_to_paragraphs` replaces its role.

```python
def load_pdf(
    path: str, describe_figure: Callable[[bytes], str] | None = None, text_only: bool = False
) -> CanonicalDoc:
    """... (existing docstring unchanged, describe_figure/text_only
    paragraphs stay as-is) ..."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.PDF, sha256=sha256)

    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_id = 0
    figure_id = 0

    with pdfplumber.open(path) as pdf:
        # First pass: every page's own lines (cheap -- no table/image work
        # yet), collected once so header/footer recurrence can be checked
        # across the WHOLE document before the real per-page build below
        # decides what to keep. See _detect_boilerplate_templates' own
        # docstring for why this must be a first pass, not decided
        # page-by-page (a header/footer's own defining property is that it
        # recurs ACROSS pages -- no single page's content can prove that).
        all_pages_lines: list[list[dict]] = [page.extract_text_lines() for page in pdf.pages]
        pages_first_lines = [lines[0]["text"] if lines else "" for lines in all_pages_lines]
        pages_last_lines = [lines[-1]["text"] if lines else "" for lines in all_pages_lines]
        header_templates, footer_templates = _detect_boilerplate_templates(pages_first_lines, pages_last_lines)

        for page_number, page in enumerate(pdf.pages, start=1):
            found_tables = [] if text_only else page.find_tables()
            table_bboxes = [t.bbox for t in found_tables]

            page_lines = all_pages_lines[page_number - 1]
            if table_bboxes:
                page_lines = [
                    line for line in page_lines
                    if not _inside_any_bbox({"x0": line["x0"], "top": line["top"], "x1": line["x1"], "bottom": line["bottom"]}, table_bboxes)
                ]

            # Drop a line that's a confirmed recurring header (first line
            # of the page) or footer (last line) template -- checked by
            # POSITION (first/last of THIS page's own line list, matching
            # how the recurrence pass above characterized candidates), not
            # by re-scanning every line against both template sets.
            filtered_lines = list(page_lines)
            if filtered_lines and _normalize_digits(filtered_lines[0]["text"]) in header_templates:
                filtered_lines = filtered_lines[1:]
            if filtered_lines and _normalize_digits(filtered_lines[-1]["text"]) in footer_templates:
                filtered_lines = filtered_lines[:-1]

            paragraphs_with_tops = _lines_to_paragraphs(filtered_lines)
            paragraphs = [p for p, _ in paragraphs_with_tops]
            tops = [t for _, t in paragraphs_with_tops]

            page_tables: list[Table] = []
            for found_table in found_tables:
                try:
                    cells, column_widths = _build_pdf_table_grid(page, found_table)
                except Exception:  # noqa: BLE001
                    cells = [[TableCell(text=cell or "") for cell in row] for row in found_table.extract()]
                    column_widths = None
                page_tables.append(
                    Table(
                        id=f"t{table_id}",
                        cells=cells,
                        column_widths=column_widths,
                        border_style="grid",
                        style_provenance="heuristic",
                        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0, page=page_number),
                    )
                )
                table_id += 1

            page_images: list[tuple[float, object]] = []
            if not text_only:
                pypdf_page = cached_pdf_reader(path).pages[page_number - 1]
                plumber_tops = [im["top"] for im in page.images]
                page_images = [
                    (plumber_tops[i] if i < len(plumber_tops) else 0.0, pypdf_image)
                    for i, pypdf_image in enumerate(pypdf_page.images)
                ]

            merged = sorted(
                [("paragraph", top, paragraph) for top, paragraph in zip(tops, paragraphs)]
                + [("table", bbox[1], table) for bbox, table in zip(table_bboxes, page_tables)]
                + [("image", top, pypdf_image) for top, pypdf_image in page_images],
                key=lambda entry: entry[1],
            )
            offset = 0
            for kind, _top, item in merged:
                if kind == "paragraph":
                    start = offset
                    end = start + len(item)
                    offset = end + 1
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.PARAGRAPH,
                            text=item,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                    block_id += 1
                elif kind == "table":
                    start = offset
                    end = start + 1
                    offset = end
                    table = item
                    tables.append(
                        Table(
                            id=table.id, cells=table.cells, column_widths=table.column_widths,
                            border_style=table.border_style, style_provenance=table.style_provenance,
                            caption=table.caption,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                        )
                    )
                else:
                    start = offset
                    end = start + 1
                    offset = end
                    pypdf_image = item
                    caption = None
                    if describe_figure is not None:
                        try:
                            caption = describe_figure(pypdf_image.data)
                        except Exception:  # noqa: BLE001
                            caption = None
                    figures.append(
                        Figure(id=f"f{figure_id}", caption=caption,
                               source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number))
                    )
                    blocks.append(
                        Block(id=f"b{block_id}", kind=BlockKind.FIGURE, text=f"[FIGURE: {caption or 'none'}]",
                              source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number))
                    )
                    block_id += 1
                    figure_id += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
```

Note the `_inside_any_bbox` reuse for filtering table-region LINES (not chars) — `_inside_any_bbox` already takes a plain dict with `x0`/`top`/`x1`/`bottom` keys (see its existing signature at `~line 473`), so a line dict (which has those same keys) works directly, no new helper needed.

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS, including every pre-existing table/figure/color/alignment test — this task only changes the paragraph/header/footer path, table/figure extraction is untouched.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "fix(pdf_loader): real line-level paragraph segmentation + header/footer suppression"
```

---

## Task 3: Phase 2 — Heading detection

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (the per-page loop's paragraph-emission code, inside `load_pdf`)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `_line_size`/`_line_is_bold`/`_lines_to_paragraphs` (Task 2), `app.leveling.numbering.parse_numbering`/`numbering_depth` (existing, shared with docx), `pypdf.PdfReader.outline` (real API, confirmed: returns a nested `list[Destination | list[...]]`, each `Destination` has `.title`/`.page`/`.top`/`.left`).
- Produces: no new importable function beyond what's described below — heading classification happens inline in `load_pdf`'s paragraph-emission step, since it needs the per-document font-size histogram Task 2's first pass already computes lines for.

### Font-size histogram + heading classification

```python
# A heading candidate's line size must exceed the document's own dominant
# body-text size by at least this many points to be classified a heading
# -- guards against pdfplumber's float noise re-triggering on lines that
# are only trivially, insignificantly larger than body text.
_HEADING_SIZE_MARGIN = 0.5


def _dominant_body_size(all_pages_lines: list[list[dict]]) -> float:
    """Mode of every line's own font size across the WHOLE document --
    body text dominates by sheer line count in any real document (verified
    live: 6041 tokens at 10.0pt vs 41 at 12.0pt/25 at 14.0pt on a real
    82-page ICD), so the single most common line-size IS the body size,
    no separate body-vs-heading classifier needed. Document-level, not
    per-page -- a page that's mostly a table or figure would otherwise
    skew a per-page-only histogram; body text is consistent across a real
    document's OWN pages (confirmed: 11.04pt/10.0pt each held steady
    across dozens of sampled pages in this design's research)."""
    from collections import Counter

    sizes = [_line_size(line) for lines in all_pages_lines for line in lines if line.get("chars")]
    if not sizes:
        return 0.0
    return Counter(sizes).most_common(1)[0][0]
```

Heading-number-synthesis counter (same validated algorithm as docx's Task 9 — reimplemented locally per this task's own convention, not shared):

```python
def _heading_level_from_size_rank(size: float, body_size: float, size_ranks: dict[float, int]) -> int:
    """Font-size-cluster rank as the heading DEPTH fallback -- used only
    when a heading candidate's own text has no parseable number (see the
    layered-signal design: font size decides IF a line is a heading;
    parse_numbering decides WHAT depth when it parses; this function is
    the depth fallback when it doesn't). `size_ranks` maps every distinct
    heading-candidate size seen so far to a 1-based depth rank, LARGEST
    size = rank 1 (shallowest) -- built incrementally as new sizes are
    encountered, so a document's actual heading sizes (whatever they are)
    define their own depth ordering rather than assuming a fixed set of
    sizes up front."""
    if size not in size_ranks:
        # New size -- rank it below every size seen so far that's
        # LARGER than it (a genuinely new, smaller heading size is a
        # deeper level than every larger size already ranked).
        deeper_than = sum(1 for s in size_ranks if s > size)
        size_ranks[size] = deeper_than + 1
    return size_ranks[size]
```

Heading-number counter (mirrors docx's validated mixed-numbering-safe algorithm exactly):

```python
def _advance_heading_counter(heading_counters: list[int], heading_level: int, existing_label: str | None) -> str | None:
    """Same validated algorithm as docx_loader.py's heading-number
    synthesis (commit history: fc16a9e, 6c07360) -- reimplemented here
    per this task's own non-goal (no shared-module refactor of
    docx_loader.py). Always extends/truncates `heading_counters` for
    EVERY heading regardless of self-numbering (the mixed-numbering fix);
    adopts an already-numbered heading's own label into the counter state
    when it parses AND its depth matches `heading_level`, so later
    unnumbered siblings continue from the real numbers rather than
    colliding with them. Mutates `heading_counters` in place. Returns the
    synthesized label, or None when the heading is self-numbered (its own
    text already carries the number -- text is left as-is, matching
    docx's own convention of never stripping an existing number out of
    a heading's text into a separate field)."""
    while len(heading_counters) < heading_level:
        heading_counters.append(0)
    del heading_counters[heading_level:]
    if existing_label is not None:
        parts = existing_label.split(".")
        if len(parts) == heading_level and all(p.isdigit() for p in parts):
            heading_counters[:] = [int(p) for p in parts]
        return None
    heading_counters[heading_level - 1] += 1
    return ".".join(str(n) for n in heading_counters)
```

Outline/bookmark tier-0 matching:

```python
def _outline_heading_positions(path: str) -> dict[tuple[int, str], int]:
    """(page_number, title) -> outline depth (1-based), for every REAL
    outline/bookmark entry in the document -- confirmed real API:
    pypdf.PdfReader.outline is a nested list of Destination objects
    (Destination.title/.page/.top/.left), deeper nesting = deeper list.
    reader.get_page_number(dest) resolves a Destination's indirect page
    reference to a real 0-based page index. Degrades to an empty dict
    (never raises) on ANY failure -- a malformed/absent outline must fall
    through to font-size/numbering classification, never abort the load
    or mis-anchor a heading."""
    positions: dict[tuple[int, str], int] = {}

    def _walk(items, depth: int, reader) -> None:
        for item in items:
            if isinstance(item, list):
                _walk(item, depth + 1, reader)
                continue
            try:
                page_number = reader.get_page_number(item) + 1
                positions[(page_number, item.title)] = depth
            except Exception:  # noqa: BLE001 -- one malformed entry must not lose the rest of the outline
                continue

    try:
        reader = cached_pdf_reader(path)
        _walk(reader.outline, 1, reader)
    except Exception:  # noqa: BLE001 -- an absent/malformed outline degrades to "no tier-0 signal", never raises
        return {}
    return positions
```

### Wiring into `load_pdf`'s paragraph loop

Requires threading `heading_counters: list[int]` and `size_ranks: dict[float, int]` (both initialized once, outside the page loop, so they persist correctly across the whole document — same "one running counter for the whole document" shape as docx's `heading_counters`), and the outline positions dict (computed once, before the page loop).

In the per-page loop, `paragraphs_with_tops` (Task 2's `_lines_to_paragraphs` output) doesn't carry font-size info per merged paragraph — Task 2's function needs a small addition: return the FIRST line's own size/boldness alongside `(text, top)`, so heading classification has what it needs without re-deriving it. Extend `_lines_to_paragraphs`'s return shape:

```python
def _lines_to_paragraphs(lines: list[dict]) -> list[tuple[str, float, float, bool]]:
    """... (same docstring as Task 2, extended) ... Returns
    (paragraph_text, top, size, is_bold) tuples -- size/is_bold are the
    FIRST line's own values (a merged multi-line paragraph is, by the
    merge rule itself, uniform in size -- see _PARAGRAPH_LINE_SIZE_TOLERANCE
    -- so the first line's size IS the paragraph's size)."""
    if not lines:
        return []
    paragraphs: list[tuple[str, float, float, bool]] = []
    current_texts = [lines[0]["text"]]
    current_top = lines[0]["top"]
    current_size = _line_size(lines[0])
    current_bold = _line_is_bold(lines[0])
    prev_bottom = lines[0]["bottom"]
    prev_size = current_size
    for line in lines[1:]:
        size = _line_size(line)
        gap = line["top"] - prev_bottom
        same_size = abs(size - prev_size) <= _PARAGRAPH_LINE_SIZE_TOLERANCE
        small_gap = gap <= max(size, prev_size) * _PARAGRAPH_LINE_GAP_RATIO
        if same_size and small_gap:
            current_texts.append(line["text"])
        else:
            paragraphs.append((" ".join(current_texts), current_top, current_size, current_bold))
            current_texts = [line["text"]]
            current_top = line["top"]
            current_size = size
            current_bold = _line_is_bold(line)
        prev_bottom = line["bottom"]
        prev_size = size
    paragraphs.append((" ".join(current_texts), current_top, current_size, current_bold))
    return paragraphs
```

(This changes Task 2's return shape from a 2-tuple to a 4-tuple — update Task 2's own test assertions accordingly if implementing sequentially; both tasks' tests must agree on the final 4-tuple shape since Task 3 lands after Task 2 in this plan.)

In `load_pdf`, before the per-page loop:

```python
        heading_counters: list[int] = []
        size_ranks: dict[float, int] = {}
        body_size = _dominant_body_size(all_pages_lines)
        outline_positions = _outline_heading_positions(path)
```

Inside the per-page loop, replace the paragraph-tuple unpacking and emission:

```python
            paragraphs_with_meta = _lines_to_paragraphs(filtered_lines)
            paragraphs = [p for p, _, _, _ in paragraphs_with_meta]
            tops = [t for _, t, _, _ in paragraphs_with_meta]
```

And in the merged-order emission loop's `"paragraph"` branch, replace the block-construction with:

```python
                if kind == "paragraph":
                    start = offset
                    end = start + len(item)
                    offset = end + 1
                    text, size, is_bold, para_top = item
                    outline_depth = outline_positions.get((page_number, text.strip()))
                    heading_level: int | None = None
                    number_label: str | None = None
                    if outline_depth is not None:
                        heading_level = outline_depth
                    elif size > body_size + _HEADING_SIZE_MARGIN:
                        existing_label, _ = parse_numbering(text)
                        if existing_label is not None:
                            heading_level = numbering_depth(existing_label)
                        else:
                            heading_level = _heading_level_from_size_rank(size, body_size, size_ranks)
                    if heading_level is not None:
                        existing_label, _ = parse_numbering(text)
                        number_label = _advance_heading_counter(heading_counters, heading_level, existing_label)
                        blocks.append(
                            Block(
                                id=f"b{block_id}", kind=BlockKind.HEADING, text=text,
                                heading_level=heading_level, number_label=number_label,
                                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                            )
                        )
                    else:
                        blocks.append(
                            Block(
                                id=f"b{block_id}", kind=BlockKind.PARAGRAPH, text=text,
                                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                            )
                        )
                    block_id += 1
```

This requires changing the `merged` list's `"paragraph"` tuples to carry `(text, size, is_bold, top)` as the item (currently just `paragraph` text) — update the `merged = sorted([...])` construction's paragraph list comprehension to `[("paragraph", top, (text, size, is_bold, top)) for text, top, size, is_bold in paragraphs_with_meta]`.

Add the required import at the top of the file: `from app.leveling.numbering import parse_numbering, numbering_depth`.

**Watermark exclusion** (required by this task, not deferred): a watermark's font size can be the largest on a page. Exclude any line whose text, after stripping whitespace, exactly matches a known watermark pattern from heading candidacy — reuse the existing fixture (`tests/fixtures/watermarked_sample.pdf`) to write a regression test proving a watermark-sized line does NOT get classified as a heading. Concretely: a heading candidate must also have a REASONABLE length (a watermark is typically one or two words rendered very large, e.g. "DRAFT" at 40+pt while body is 10pt — an outlier so extreme it's more plausibly decorative than a real heading). Add a defensive upper bound:

```python
# A heading candidate whose size exceeds the body size by more than this
# multiple is more likely a watermark/decorative element than a real
# heading -- real document headings in this design's sampled corpus never
# exceeded ~2.2x body size (24pt/11pt on the LVC Gateway ICD's title
# page); a watermark rendered to dominate a page visually often goes
# several times larger than that.
_HEADING_SIZE_MAX_RATIO = 3.0
```

and gate: `elif body_size < size <= body_size * _HEADING_SIZE_MAX_RATIO:` in place of the plain `size > body_size + _HEADING_SIZE_MARGIN` check above.

- [ ] **Step 1: Write the failing tests**

```python
def test_load_pdf_detects_a_heading_via_font_size_outlier() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "heading.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica-Bold", 18)
        c.drawString(72, 700, "Introduction")
        c.setFont("Helvetica", 10)
        c.drawString(72, 670, "Body text at normal size.")
        c.save()
        result = load_pdf(str(path))

    heading = next(b for b in result.blocks if b.text == "Introduction")
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 1
    body = next(b for b in result.blocks if "Body text" in b.text)
    assert body.kind == BlockKind.PARAGRAPH


def test_load_pdf_uses_own_numbering_for_heading_depth_when_present() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "numbered_heading.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(72, 700, "1.1 Scope")
        c.setFont("Helvetica", 10)
        c.drawString(72, 670, "Body text.")
        c.save()
        result = load_pdf(str(path))

    heading = next(b for b in result.blocks if "Scope" in b.text)
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 2  # from "1.1", not a size-rank guess
    assert heading.number_label is None  # self-numbered, text kept as-is, no synthesis


def test_load_pdf_synthesizes_a_number_for_an_unnumbered_heading() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "unnumbered_headings.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(72, 750, "Introduction")
        c.setFont("Helvetica", 10)
        c.drawString(72, 720, "Body one.")
        c.setFont("Helvetica-Bold", 16)
        c.drawString(72, 690, "Scope")
        c.setFont("Helvetica", 10)
        c.drawString(72, 660, "Body two.")
        c.save()
        result = load_pdf(str(path))

    headings = [b for b in result.blocks if b.kind == BlockKind.HEADING]
    assert [h.number_label for h in headings] == ["1", "2"]


def test_load_pdf_watermark_sized_text_is_not_classified_as_heading() -> None:
    # Regression guard: a watermark can be the largest font on a page --
    # must not be promoted to HEADING just because it's an outlier.
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "watermarked.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 60)  # watermark-sized, far beyond _HEADING_SIZE_MAX_RATIO x body
        c.drawString(150, 400, "DRAFT")
        c.setFont("Helvetica", 10)
        c.drawString(72, 700, "Real body text on this page.")
        c.save()
        result = load_pdf(str(path))

    draft_block = next(b for b in result.blocks if b.text == "DRAFT")
    assert draft_block.kind == BlockKind.PARAGRAPH  # excluded from heading candidacy, not promoted
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -k "detects_a_heading or uses_own_numbering or synthesizes_a_number or watermark_sized" -v`
Expected: all FAIL — every block currently comes back `PARAGRAPH`, none `HEADING`.

- [ ] **Step 3: Implement the fix**

Apply every code block described above (constants, `_dominant_body_size`, `_heading_level_from_size_rank`, `_advance_heading_counter`, `_outline_heading_positions`, the extended `_lines_to_paragraphs` 4-tuple return, the `load_pdf` wiring, the import, and the watermark max-ratio gate).

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(pdf_loader): heading detection via font-size outlier, numbering depth, outline tier-0"
```

---

## Task 4: Regression check — golden fixtures + docx_pagination consumer

**Files:**
- Test only: `ingestion/tests/test_pdf_loader.py`, `ingestion/tests/test_docx_pagination.py`, whichever golden-fixture test file already exists for SURVEY branching (grep `tests/` for `golden` first — confirm the exact filename before writing this task's steps, do not assume `test_survey_golden.py` is the real name).

**Interfaces:**
- Consumes: `load_pdf`/`load_pdf_with_ocr_fallback` (Tasks 1-3, now producing real headings/paragraphs/suppressed boilerplate).
- Produces: nothing new — this task is verification only.

Tasks 2-3 change per-block token counts (real headings/paragraphs instead of one page-blob), which can flip `fits_whole_document` for a borderline document and change which `build_survey_tree` code path fires. Also verify `docx_pagination.py`'s `load_pdf(text_only=True)` consumer (`_build_page_index`, joins per-page block texts with `" "`) isn't broken by header/footer removal — LibreOffice-converted docx-to-PDF carries the docx's own headers, so removal is *likely* a net alignment improvement, but must be verified, not assumed.

- [ ] **Step 1: Confirm neither existing golden file covers this (already verified)**

Two golden-fixture files exist: `tests/test_survey_golden.py` tests `build_survey_requirements` (an older, different function — not `build_survey_tree`) against a synthetic informal-text client; `tests/test_fidelity_golden.py` tests BASELINE-mode byte-for-byte description folding via `build_baseline_tree`, not SURVEY-mode branch/token-estimate stability. **Neither exercises what Tasks 2-3 can regress** (SURVEY branch/node-count stability driven by real PDF heading/paragraph structure) — confirmed by reading both files in full. This means Step 2 below is the real deliverable, not a conditional fallback.

- [ ] **Step 2: Add a new PDF-sourced SURVEY golden test**

Add `tests/test_pdf_survey_golden.py` (new file, following `test_survey_golden.py`'s naming convention but exercising `build_survey_tree` directly, not `build_survey_requirements`). Use a real excerpt from one of this design's downloaded documents (see the design spec's Testing section for the fixture inventory) or a synthetic multi-heading, multi-page reportlab PDF exercising Tasks 2-3's real behavior together (running header + numbered headings + a wrapped paragraph), asserting the resulting node count/branch structure is stable and specific (pinning real values, not just "doesn't crash" — the actual point of a golden test):

```python
def test_pdf_survey_golden_produces_stable_branch_and_heading_structure() -> None:
    from app.leveling.llm_leveling import build_survey_tree
    from app.loaders.pdf_loader import load_pdf

    # Real excerpt or synthetic fixture with 2 numbered top-level headings,
    # a running header repeated on every page, and one wrapped paragraph --
    # exercises Tasks 2+3 together end to end.
    doc = load_pdf(str(FIXTURES / "pdf_survey_golden_fixture.pdf"))
    fake = FakeSectionAnalysisClient()  # reuse test_llm_leveling.py's own fake, or a local equivalent
    tree = build_survey_tree(doc, fake)

    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [h.number_label for h in headings] == ["1", "2"]  # pinned, not just non-empty
    assert not any("REV" in b.text for b in doc.blocks if b.kind == BlockKind.PARAGRAPH)  # header suppressed
```

- [ ] **Step 3: Run the new golden test**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_survey_golden.py -v`
Expected: PASS with the pinned values above.

- [ ] **Step 4: Verify `docx_pagination.py`'s `load_pdf(text_only=True)` consumer**

Read `ingestion/app/loaders/docx_pagination.py`'s `_build_page_index` (confirmed present around lines 158-186 per this design's own research) and its existing test file `ingestion/tests/test_docx_pagination.py` in full first. Run the existing suite:

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_pagination.py -v`
Expected: PASS, unchanged — `docx_pagination.py` already has its own synthetic multi-block-page tests (per this design's research), and header/footer removal changing which text ends up in each page's joined block text is exactly what those tests would catch if it broke real docx-to-PDF page alignment. If any test fails, do NOT force a fix blindly — `settings.docx_page_alignment_enabled` is the existing kill switch if header/footer removal turns out to genuinely regress alignment; document the finding and disable per-feature rather than reverting Tasks 2-3 wholesale.

- [ ] **Step 5: Commit**

```bash
git add ingestion/tests/
git commit -m "test(pdf_loader): golden-fixture and docx_pagination regression coverage for segmentation/heading changes"
```

---

## Task 5: Phase 3a — Cross-page table continuation merge

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (`load_pdf`'s table-building section)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `_build_pdf_table_grid` (existing), the `xs`/`ys` column/row edge sets it already computes internally (need to expose per-table for the cross-page alignment check).
- Produces: `_tables_continue(prev_table_xs: list[float], prev_bottom: float, prev_page_height: float, next_table_xs: list[float], next_top: float) -> bool` (module-level function).

A continuation candidate requires: the prior table's bottom edge sits in the page's bottom band, the next table's top edge sits in the next page's top band, AND column x-edges align (not merely "same column count" — verified this would incorrectly merge two unrelated same-shaped tables on consecutive pages).

```python
# A table's bottom/top edge must fall within this fraction of the page
# height from the respective page edge to be a continuation candidate --
# a table that ends/starts well away from a page boundary is unlikely to
# be a real continuation regardless of column alignment.
_TABLE_CONTINUATION_EDGE_BAND_FRACTION = 0.15

# Column x-edges must align within this many points to be considered the
# "same" columns across a page break -- pdfplumber's own geometry can
# differ by a point or two between pages due to sub-pixel rendering, same
# tolerance class as this file's other geometric comparisons.
_TABLE_CONTINUATION_X_TOLERANCE = 2.0


def _tables_continue(
    prev_table_xs: list[float], prev_bottom: float, prev_page_height: float,
    next_table_xs: list[float], next_top: float,
) -> bool:
    """True when a table ending near the bottom of one page and a table
    starting near the top of the next page are plausibly the SAME table,
    continued -- requires both a positional signal (near the respective
    page edge) AND a structural signal (aligned column x-edges), not
    column COUNT alone (verified: two unrelated same-column-count tables
    on consecutive pages would otherwise merge incorrectly)."""
    near_bottom = prev_bottom >= prev_page_height * (1 - _TABLE_CONTINUATION_EDGE_BAND_FRACTION)
    near_top = next_top <= prev_page_height * _TABLE_CONTINUATION_EDGE_BAND_FRACTION
    if not (near_bottom and near_top):
        return False
    if len(prev_table_xs) != len(next_table_xs):
        return False
    return all(abs(a - b) <= _TABLE_CONTINUATION_X_TOLERANCE for a, b in zip(prev_table_xs, next_table_xs))
```

Wiring: after the full per-page loop finishes building `tables` (all pages), do a second pass merging adjacent-page continuation candidates. This must run AFTER the main loop (needs every page's tables already built with real page numbers) — add as a post-processing step right before `return CanonicalDoc(...)`:

```python
    tables = _merge_continued_tables(tables)


def _merge_continued_tables(tables: list[Table]) -> list[Table]:
    """Post-pass merging cross-page table continuations -- must run AFTER
    every table on every page has been built (needs real page numbers to
    know which tables are on ADJACENT pages at all). Merges row-wise: the
    continuation's cells become additional rows appended to the prior
    table; the continuation's own Table entry is dropped from the result.
    Only ever merges a table into the ONE immediately preceding it in
    document order -- a three-page continuation chains through two
    successive merges, not a single three-way merge, which keeps this
    function's own logic to a single pairwise rule applied repeatedly."""
    if len(tables) < 2:
        return tables
    merged: list[Table] = [tables[0]]
    for table in tables[1:]:
        prev = merged[-1]
        prev_page = prev.source_ref.page
        this_page = table.source_ref.page
        if prev_page is None or this_page is None or this_page != prev_page + 1:
            merged.append(table)
            continue
        prev_xs = sorted({0.0 for _ in prev.cells[0]}) if False else None  # placeholder removed below
        merged.append(table)
    return merged
```

**Note for the implementer**: the placeholder line above (`prev_xs = sorted(...) if False else None`) is intentionally NOT real code — `Table.cells`/`TableCell` (the canonical model, already built by `_build_pdf_table_grid`) does not itself retain the raw `xs` column-edge list `_build_pdf_table_grid` computed internally and then discarded. To make `_merge_continued_tables` work, `_build_pdf_table_grid` must ALSO return the `xs` list it already computes (`~line 384`: `xs = sorted({c[0] for c in found_table.cells})`), so the per-page loop can carry it forward per-table for this post-pass to consume. Change `_build_pdf_table_grid`'s return type from `tuple[list[list[TableCell | None]], list[float] | None]` to `tuple[list[list[TableCell | None]], list[float] | None, list[float]]` (adding `xs` as a third return value), update its one call site in the per-page loop to capture it, and thread it into a side dict (`table_xs_by_id: dict[str, list[float]]`) built during the main loop, passed into `_merge_continued_tables(tables, table_xs_by_id, page_height)` (page height available via `page.height` inside the loop, captured once since all pages in a real document share it).

Rewrite `_merge_continued_tables` with this real signature:

```python
def _merge_continued_tables(tables: list[Table], table_xs_by_id: dict[str, list[float]], page_height: float) -> list[Table]:
    """... (same docstring as above) ..."""
    if len(tables) < 2:
        return tables
    merged: list[Table] = [tables[0]]
    for table in tables[1:]:
        prev = merged[-1]
        prev_page = prev.source_ref.page
        this_page = table.source_ref.page
        can_continue = (
            prev_page is not None and this_page is not None and this_page == prev_page + 1
            and _tables_continue(
                table_xs_by_id.get(prev.id, []), prev.source_ref.end_offset if False else _table_bottom(prev, page_height),
                page_height, table_xs_by_id.get(table.id, []), _table_top(table),
            )
        )
        if can_continue:
            merged[-1] = prev.model_copy(update={"cells": prev.cells + table.cells})
        else:
            merged.append(table)
    return merged
```

This references `_table_bottom`/`_table_top`, which don't exist yet — `Table`'s own `source_ref` only carries a synthetic `(0, 0)` offset (per this file's existing convention, tables never get real char-span offsets), so the table's real vertical position must come from elsewhere. Simplify instead: capture each table's real bbox `top`/`bottom` (from `found_table.bbox`, already available in the main loop where the table is built) into a SEPARATE side dict alongside `table_xs_by_id`, rather than trying to recover it from `Table`/`SourceRef` after the fact. Revise the wiring:

```python
    # In the main per-page loop, alongside table_id += 1:
    table_xs_by_id[f"t{table_id - 1}"] = xs  # from _build_pdf_table_grid's new third return value
    table_bbox_by_id[f"t{table_id - 1}"] = found_table.bbox  # (x0, top, x1, bottom)
```

```python
def _merge_continued_tables(
    tables: list[Table], table_xs_by_id: dict[str, list[float]],
    table_bbox_by_id: dict[str, tuple[float, float, float, float]], page_height: float,
) -> list[Table]:
    """Post-pass merging cross-page table continuations. Only ever merges
    into the ONE immediately preceding table in document order."""
    if len(tables) < 2:
        return tables
    merged: list[Table] = [tables[0]]
    for table in tables[1:]:
        prev = merged[-1]
        prev_page = prev.source_ref.page
        this_page = table.source_ref.page
        prev_bottom = table_bbox_by_id.get(prev.id, (0, 0, 0, 0))[3]
        this_top = table_bbox_by_id.get(table.id, (0, 0, 0, 0))[1]
        if (
            prev_page is not None and this_page is not None and this_page == prev_page + 1
            and _tables_continue(table_xs_by_id.get(prev.id, []), prev_bottom, page_height, table_xs_by_id.get(table.id, []), this_top)
        ):
            merged[-1] = prev.model_copy(update={"cells": prev.cells + table.cells})
        else:
            merged.append(table)
    return merged
```

- [ ] **Step 1: Write the failing test**

```python
def test_load_pdf_merges_a_table_continuing_across_a_page_break() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Table as RLTable, TableStyle, Spacer
    from reportlab.lib import colors
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "cross_page_table.pdf"
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
        # Enough rows to force a real page break inside ONE reportlab Table
        # flowable -- reportlab itself splits it across pages, producing the
        # exact "same table, split by pdfplumber's own per-page find_tables()"
        # case this task fixes.
        rows = [["Code", "Meaning"]] + [[str(i), f"Reason {i}"] for i in range(60)]
        doc.build([RLTable(rows, style=style)])
        result = load_pdf(str(path))

    assert len(result.tables) == 1
    from app.canonical.model import plain_text_rows
    all_rows = plain_text_rows(result.tables[0])
    assert len(all_rows) == 61  # header + 60 rows, all in ONE table, not split
    assert all_rows[-1] == ["59", "Reason 59"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py::test_load_pdf_merges_a_table_continuing_across_a_page_break -v`
Expected: FAIL — `len(result.tables) == 2` (or more), not `1`.

- [ ] **Step 3: Implement the fix**

Apply `_tables_continue` and the corrected `_merge_continued_tables` (with `table_xs_by_id`/`table_bbox_by_id` side dicts) as shown above. Update `_build_pdf_table_grid`'s return type to include `xs` as a third value, update its one call site, and wire the side-dict population into the main per-page loop.

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(pdf_loader): merge tables continuing across a page break"
```

---

## Task 6: Phase 3b — `Table.caption` population

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (the per-page loop, table-building section)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `paragraphs_with_meta` (Task 2/3's line-merge output) — a `"Table N: <title>"`-shaped paragraph immediately preceding a table in document order becomes that table's caption.
- Produces: no new function — a small addition inside the existing merge-and-emit loop.

```python
# A caption line's own text must match this shape to be attached to the
# immediately-following table -- deliberately narrow (starts with "Table"
# + a number) rather than "any short line before a table," to avoid
# misattributing an unrelated short paragraph as a caption.
_TABLE_CAPTION_PATTERN = re.compile(r"^Table\s+[\w.]+[:.]?\s*(.*)$", re.IGNORECASE)
```

In the merged-order emission loop, when a `"table"` entry is encountered, check whether the immediately preceding emitted block (if any, and if it's the LAST thing emitted, i.e. adjacent in `merged` order) is a `PARAGRAPH` whose text matches `_TABLE_CAPTION_PATTERN` — if so, set that table's `caption` from the match, and do NOT also emit the caption paragraph as its own block (matching the docx-loader's own Caption-paragraph-to-figure-linking precedent — link, don't duplicate).

```python
            offset = 0
            pending_caption: str | None = None
            for kind, _top, item in merged:
                if kind == "paragraph":
                    text, size, is_bold, para_top = item
                    caption_match = _TABLE_CAPTION_PATTERN.match(text.strip())
                    # Only treat as a pending caption if the VERY NEXT merged
                    # entry is a table -- checked by peeking ahead, not simply
                    # "any Table-shaped line ever seen" (which could wrongly
                    # attach to a table several paragraphs later).
                    ... # see full loop restructure below
```

Given this requires look-ahead within the existing `for kind, _top, item in merged:` loop, restructure using index-based iteration instead of the current unpacking-`for`:

```python
            offset = 0
            skip_next_paragraph_as_caption_for: str | None = None
            for i, (kind, _top, item) in enumerate(merged):
                if kind == "paragraph":
                    text, size, is_bold, para_top = item
                    is_caption_candidate = bool(_TABLE_CAPTION_PATTERN.match(text.strip()))
                    next_is_table = i + 1 < len(merged) and merged[i + 1][0] == "table"
                    if is_caption_candidate and next_is_table:
                        # Defer emission entirely -- attach to the table
                        # below instead of appending a PARAGRAPH block here.
                        caption_match = _TABLE_CAPTION_PATTERN.match(text.strip())
                        pending_table_caption = caption_match.group(1).strip() or text.strip()
                        continue
                    start = offset
                    end = start + len(text)
                    offset = end + 1
                    outline_depth = outline_positions.get((page_number, text.strip()))
                    heading_level: int | None = None
                    if outline_depth is not None:
                        heading_level = outline_depth
                    elif body_size < size <= body_size * _HEADING_SIZE_MAX_RATIO:
                        existing_label, _ = parse_numbering(text)
                        heading_level = numbering_depth(existing_label) if existing_label is not None else _heading_level_from_size_rank(size, body_size, size_ranks)
                    if heading_level is not None:
                        existing_label, _ = parse_numbering(text)
                        number_label = _advance_heading_counter(heading_counters, heading_level, existing_label)
                        blocks.append(Block(id=f"b{block_id}", kind=BlockKind.HEADING, text=text, heading_level=heading_level, number_label=number_label,
                                             source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number)))
                    else:
                        blocks.append(Block(id=f"b{block_id}", kind=BlockKind.PARAGRAPH, text=text,
                                             source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number)))
                    block_id += 1
                elif kind == "table":
                    start = offset
                    end = start + 1
                    offset = end
                    table = item
                    caption = pending_table_caption if "pending_table_caption" in dir() else None
                    tables.append(Table(id=table.id, cells=table.cells, column_widths=table.column_widths,
                                         border_style=table.border_style, style_provenance=table.style_provenance,
                                         caption=caption,
                                         source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number)))
                    pending_table_caption = None
                else:
                    ... # image branch unchanged from Task 2
```

**Note for the implementer**: `"pending_table_caption" in dir()` is a placeholder anti-pattern flagged deliberately — do not ship it. Initialize `pending_table_caption: str | None = None` once, alongside `offset = 0`, at the top of the merged-order loop (same scope as `offset`), so the `elif kind == "table":` branch can read it directly without a `dir()` existence check. Set it inside the `if is_caption_candidate and next_is_table:` branch above, read-and-reset it (`caption = pending_table_caption; pending_table_caption = None`) inside the table branch.

- [ ] **Step 1: Write the failing test**

```python
def test_load_pdf_attaches_a_table_caption_from_the_preceding_line() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Table as RLTable, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib import colors
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "captioned_table.pdf"
        styles = getSampleStyleSheet()
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
        doc.build([
            Paragraph("Table 3.4: Response Codes", styles["BodyText"]),
            RLTable([["Code", "Meaning"], ["01", "Rejected"]], style=style),
        ])
        result = load_pdf(str(path))

    assert len(result.tables) == 1
    assert result.tables[0].caption == "Response Codes"
    # The caption line is NOT also emitted as its own PARAGRAPH block.
    assert not any("Table 3.4" in b.text for b in result.blocks if b.kind == BlockKind.PARAGRAPH)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py::test_load_pdf_attaches_a_table_caption_from_the_preceding_line -v`
Expected: FAIL — `result.tables[0].caption is None`.

- [ ] **Step 3: Implement the fix**

Apply the restructured merged-order loop with `pending_table_caption` properly initialized (not the `dir()` placeholder) and the `_TABLE_CAPTION_PATTERN` regex constant.

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(pdf_loader): attach a 'Table N: <title>' caption line to its table"
```

---

## Task 7: Phase 3c — Borderless (text-strategy) table detection + validation + `border_style` fix

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (the per-page loop's table-finding call, `_build_pdf_table_grid`'s `border_style` assignment)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: pdfplumber's `find_tables(table_settings={'vertical_strategy': 'text', 'horizontal_strategy': 'text'})` (real, confirmed working).
- Produces: `_is_chopped_word_boundary(prev_text: str, cur_text: str) -> bool`, `_table_has_chopped_word(rows: list[list[str]]) -> bool` (both module-level, validated live this session against a real false-positive and a real table).

**Real, tested validation rule** (verified live against `lvc_gateway_icd.pdf`'s real false-positive prose-as-table and `sample.pdf`'s real 3×3 table: 37.5% of the false positive's rows trip this rule, 0% of the real table's rows do):

```python
def _is_chopped_word_boundary(prev_text: str, cur_text: str) -> bool:
    """True if concatenating prev_text+cur_text with no separator falls
    mid-word -- a strong, checkable signal that a 'column boundary' is
    actually just where a text-strategy false-positive happened to split
    a real word, not a genuine table column edge. VERIFIED live against a
    real false positive (lvc_gateway_icd.pdf's page-8 prose-as-table,
    cells like 'F' / 'or some tests...') and a real table (this file's
    own sample.pdf fixture): 37.5% of the false positive's rows trip this
    rule, 0% of the real table's rows do -- no tuning needed, the
    separation is clean."""
    prev_stripped = prev_text.rstrip()
    cur_stripped = cur_text.lstrip()
    if not prev_stripped or not cur_stripped:
        return False
    return prev_stripped[-1].isalnum() and cur_stripped[0].islower()


def _table_has_chopped_word(rows: list[list[str]]) -> bool:
    """True if ANY row has a chopped-word boundary between adjacent
    cells -- one confirmed instance is enough to reject the whole
    candidate table (a real table never trips this at all; the false
    positive trips it on over a third of its rows, so a single hit is
    already a strong, not a borderline, signal)."""
    for row in rows:
        for i in range(1, len(row)):
            if _is_chopped_word_boundary(row[i - 1] or "", row[i] or ""):
                return True
    return False
```

Wiring: in the per-page loop, after the existing `found_tables = [] if text_only else page.find_tables()` (lines-strategy, default), ALSO try text-strategy on the same page, but only keep a text-strategy candidate that (a) doesn't overlap any already-found lines-strategy table's bbox (avoid double-detecting the same real table twice under two strategies) and (b) passes `_table_has_chopped_word`'s negative check:

```python
            found_tables = [] if text_only else page.find_tables()
            if not text_only:
                lines_bboxes = [t.bbox for t in found_tables]
                text_strategy_tables = page.find_tables(table_settings={"vertical_strategy": "text", "horizontal_strategy": "text"})
                for candidate in text_strategy_tables:
                    if _inside_any_bbox({"x0": candidate.bbox[0], "top": candidate.bbox[1], "x1": candidate.bbox[2], "bottom": candidate.bbox[3]}, lines_bboxes):
                        continue
                    if _table_has_chopped_word(candidate.extract()):
                        continue
                    found_tables.append(candidate)
```

`border_style` fix: `_build_pdf_table_grid`'s caller (the per-page loop) currently hardcodes `border_style="grid"` on every `Table(...)` construction. This must now depend on WHICH strategy found the table — track which strategy produced each `found_table` (a lines-strategy table is genuinely `"grid"`; a text-strategy table has no ruling lines by construction, so its `border_style` must be `None`):

```python
            for found_table in found_tables:
                is_text_strategy = found_table in text_strategy_tables if not text_only else False
                try:
                    cells, column_widths, xs = _build_pdf_table_grid(page, found_table)
                except Exception:  # noqa: BLE001
                    cells = [[TableCell(text=cell or "") for cell in row] for row in found_table.extract()]
                    column_widths = None
                    xs = []
                page_tables.append(
                    Table(
                        id=f"t{table_id}", cells=cells, column_widths=column_widths,
                        border_style=None if is_text_strategy else "grid",
                        style_provenance="heuristic",
                        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0, page=page_number),
                    )
                )
                table_id += 1
```

(`found_table in text_strategy_tables` — VERIFIED live this session: `pdfplumber.table.Table` defines no custom `__eq__`, so `in` correctly falls back to object identity, which is exactly what's needed here since `found_table` IS one of the same objects `text_strategy_tables` was built from. No workaround needed.)

- [ ] **Step 1: Write the failing tests**

```python
def test_load_pdf_detects_a_borderless_table_via_text_strategy() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "borderless_table.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        # A real, consistently-aligned borderless table -- same x-positions
        # per column across every row, no ruling lines drawn at all.
        rows = [("Code", "Meaning"), ("01", "Rejected"), ("02", "Accepted"), ("03", "Pending")]
        y = 700
        for code, meaning in rows:
            c.drawString(72, y, code)
            c.drawString(150, y, meaning)
            y -= 20
        c.save()
        result = load_pdf(str(path))

    assert len(result.tables) == 1
    from app.canonical.model import plain_text_rows
    assert plain_text_rows(result.tables[0])[0] == ["Code", "Meaning"]
    assert result.tables[0].border_style is None  # no ruling lines exist -- must not be "grid"


def test_load_pdf_rejects_a_prose_page_mistaken_for_a_borderless_table() -> None:
    # Regression guard for the confirmed false-positive shape: ordinary
    # wrapped prose must never be shredded into a fake table.
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "prose_only.pdf"
        styles = getSampleStyleSheet()
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        doc.build([
            Paragraph(
                "For some tests or simulations, only a subset of the listed messages will be used, "
                "and each message and its representation is presented in the sections below for reference.",
                styles["BodyText"],
            )
        ])
        result = load_pdf(str(path))

    assert result.tables == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -k "borderless_table or rejects_a_prose_page" -v`
Expected: the borderless-table test FAILS (`result.tables == []`, text-strategy detection not wired up yet). The prose-rejection test may already PASS today (since no text-strategy detection exists AT ALL yet, prose never becomes a fake table today either) — confirm this explicitly and note it as a "must still pass after the fix, not just before" case in the test's own comment, since implementing this task WITHOUT the validation layer would make this test start failing.

- [ ] **Step 3: Implement the fix**

Apply `_is_chopped_word_boundary`, `_table_has_chopped_word`, the text-strategy detection wiring, the `_build_pdf_table_grid` signature change (add `xs` as a third return value if Task 5 already changed it — if implementing in plan order, Task 5 lands first and already made this change; this task only adds the `is_text_strategy`-conditional `border_style` on top of Task 5's existing 3-tuple return), and the `border_style` fix.

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -v`
Expected: all PASS, including the prose-rejection test (now genuinely exercising the validation layer, not passing vacuously).

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(pdf_loader): borderless table detection with chopped-word validation, fix border_style hardcoding"
```

---

## Task 8: Phase 4 — AcroForm fields, fail-loud NOTE marker

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (`load_pdf`, add a post-loop pass)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `pypdf.PdfReader.get_fields()` (real, confirmed: returns `None`, not `{}`, on a document with no AcroForm — needs a guard).
- Produces: no new importable function — one `BlockKind.NOTE` block appended per document with any filled fields (not per-page, since `get_fields()` has no per-page attribution without also reading each field's `/Rect`, which this task does not attempt — see the design spec's own scoping rationale).

```python
    reader = cached_pdf_reader(path)
    try:
        fields = reader.get_fields()
    except Exception:  # noqa: BLE001 -- a malformed AcroForm must not abort the whole document load
        fields = None
    if fields:
        filled = {name: field.get("/V") for name, field in fields.items() if field.get("/V")}
        if filled:
            note_text = "[UNSUPPORTED: AcroForm fields with values -- not extracted into body content: " + \
                ", ".join(f"{name}: {value}" for name, value in filled.items()) + "]"
            blocks.append(
                Block(
                    id=f"b{block_id}", kind=BlockKind.NOTE, text=note_text,
                    source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
                )
            )
            block_id += 1
```

Place this immediately before `return CanonicalDoc(...)`.

- [ ] **Step 1: Write the failing test**

```python
def test_load_pdf_flags_filled_acroform_fields_with_a_note() -> None:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import letter
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "form.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.drawString(72, 700, "Static label text.")
        form = c.acroForm
        form.textfield(name="approver", tooltip="Approver", x=72, y=650, width=200, height=20, value="J. Smith")
        c.save()
        result = load_pdf(str(path))

    note_blocks = [b for b in result.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert "approver" in note_blocks[0].text
    assert "J. Smith" in note_blocks[0].text


def test_load_pdf_no_note_when_document_has_no_acroform() -> None:
    # Regression guard: get_fields() returns None (not {}) on a document
    # with no AcroForm at all -- must not raise or misbehave.
    result = load_pdf(str(FIXTURES / "sample.pdf"))
    assert not any(b.kind == BlockKind.NOTE for b in result.blocks)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -k "acroform" -v`
Expected: the first test FAILS (no `NOTE` block emitted yet); the second may already PASS (nothing to trigger today) — confirm and note as above.

- [ ] **Step 3: Implement the fix**

Apply the code shown above.

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(pdf_loader): flag filled AcroForm field values with a NOTE marker"
```

---

## Task 9: Phase 5 — Multi-column detection (flag-only)

**Files:**
- Modify: `ingestion/app/loaders/pdf_loader.py` (`load_pdf`'s per-page loop)
- Test: `ingestion/tests/test_pdf_loader.py`

**Interfaces:**
- Consumes: `all_pages_lines` (Task 2's first pass), `page.width`/`page.height` (existing pdfplumber attributes).
- Produces: `_detect_suspected_column_gap(lines: list[dict], page_width: float, table_bboxes: list, figure_bboxes: list) -> tuple[float, float] | None` (module-level function; returns the gap's `(x_start, x_end)` band, or `None` if no qualifying gap found).

Per the design spec: gate per-page, require a clean vertical whitespace band spanning most of the page's text height with zero words crossing it (not just the largest x0 gap — a wide table column or title-page label/value layout can produce a large gap with no real column boundary), and carve out full-width elements explicitly.

```python
# A candidate column gap must span at least this fraction of the page's
# own text height (top of the first line to the bottom of the last) to be
# considered a real column boundary, not an isolated coincidental gap on
# one or two lines (a title page's label/value layout, or a wide table
# column, both confirmed as real false candidates during this design's
# research).
_COLUMN_GAP_MIN_HEIGHT_FRACTION = 0.5

# The gap band itself must be at least this many points wide -- guards
# against a normal word-spacing gap being mistaken for a column gutter.
_COLUMN_GAP_MIN_WIDTH = 30.0


def _detect_suspected_column_gap(
    lines: list[dict], page_width: float, table_bboxes: list[tuple[float, float, float, float]],
) -> tuple[float, float] | None:
    """Flags (never splits) a page as SUSPECTED multi-column: a vertical
    band with NO word crossing it, spanning at least
    _COLUMN_GAP_MIN_HEIGHT_FRACTION of the page's own text height, at
    least _COLUMN_GAP_MIN_WIDTH points wide, that does not fall inside any
    table's own bbox (a table's internal column gaps must never trigger
    this -- a table is not a multi-column PAGE layout). Returns None (no
    action, no marker) when no such band exists, which is the ordinary
    case for the overwhelming majority of real single-column documents
    (confirmed: 0 of 9 real sampled documents in this design's own
    research were genuinely multi-column)."""
    if not lines:
        return None
    text_top = min(line["top"] for line in lines)
    text_bottom = max(line["bottom"] for line in lines)
    text_height = text_bottom - text_top
    if text_height <= 0:
        return None

    # Candidate gap boundaries: every line's own x0/x1 are potential gap
    # edges (a real column gutter's edges are defined by where TEXT stops
    # and starts, not an arbitrary grid).
    xs = sorted({line["x0"] for line in lines} | {line["x1"] for line in lines})
    for i in range(len(xs) - 1):
        gap_start, gap_end = xs[i], xs[i + 1]
        gap_width = gap_end - gap_start
        if gap_width < _COLUMN_GAP_MIN_WIDTH:
            continue
        # Any table overlapping this x-range invalidates it as a page-level
        # column gap -- it's the table's own internal structure instead.
        if any(bbox[0] < gap_end and gap_start < bbox[2] for bbox in table_bboxes):
            continue
        crossing_lines = [line for line in lines if line["x0"] < gap_end and gap_start < line["x1"]]
        if crossing_lines:
            continue
        # Height coverage: what fraction of the page's own text-height
        # range has SOME line adjacent to (bordering) this gap on either
        # side, i.e. actual column content flanking it, not just an
        # isolated one-line coincidence.
        flanking_lines = [line for line in lines if line["x1"] <= gap_start or line["x0"] >= gap_end]
        if not flanking_lines:
            continue
        flank_top = min(line["top"] for line in flanking_lines)
        flank_bottom = max(line["bottom"] for line in flanking_lines)
        if (flank_bottom - flank_top) >= text_height * _COLUMN_GAP_MIN_HEIGHT_FRACTION:
            return (gap_start, gap_end)
    return None
```

Wiring: inside the per-page loop, after `found_tables`/`table_bboxes` are known and before/alongside paragraph emission:

```python
            suspected_gap = _detect_suspected_column_gap(page_lines, page.width, table_bboxes)
            if suspected_gap is not None:
                start = offset
                end = start + 1
                offset = end
                blocks.append(
                    Block(
                        id=f"b{block_id}", kind=BlockKind.NOTE,
                        text=f"[UNSUPPORTED: page {page_number} appears multi-column (gap at x={suspected_gap[0]:.0f}-{suspected_gap[1]:.0f}) -- reading order below may be incorrect]",
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end, page=page_number),
                    )
                )
                block_id += 1
```

Place this check using `page_lines` (the table-region-filtered line list from Task 2, before header/footer stripping — a suspected column gap should be checked against the page's real content lines, header/footer stripping doesn't affect gap geometry meaningfully either way, but using the same `page_lines` variable already in scope keeps this minimal). Insert the marker block into `merged` in the SAME position pass as other page-level content — since it has no natural `top` tied to a specific paragraph, append it to `blocks` directly (as shown) rather than folding it into the `merged`-and-sorted list, so it always appears once per flagged page regardless of paragraph/table/image ordering on that page.

- [ ] **Step 1: Write the failing tests**

```python
def test_load_pdf_flags_a_suspected_multi_column_page() -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "two_col.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 12)
        y = 700
        for i in range(6):
            c.drawString(72, y - i * 20, f"LEFT-{i} column text line here")
            c.drawString(320, y - i * 20, f"RIGHT-{i} column text line here")
        c.save()
        result = load_pdf(str(path))

    note_blocks = [b for b in result.blocks if b.kind == BlockKind.NOTE and "multi-column" in b.text]
    assert len(note_blocks) == 1


def test_load_pdf_does_not_flag_a_wide_table_column_as_multi_column() -> None:
    # Regression guard for a confirmed real false candidate: a wide table
    # column produces a large x-gap with no real column boundary.
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Table as RLTable, TableStyle
    from reportlab.lib import colors
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "wide_table.pdf"
        doc = SimpleDocTemplate(str(path), pagesize=letter)
        style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
        doc.build([RLTable([["Narrow", "A much wider column with more text content in it"]], style=style, colWidths=[80, 380])])
        result = load_pdf(str(path))

    assert not any(b.kind == BlockKind.NOTE and "multi-column" in b.text for b in result.blocks)


def test_load_pdf_does_not_flag_a_title_page_label_value_layout() -> None:
    # Regression guard for the SECOND confirmed real false candidate: a
    # cover-page label/value pair (e.g. "Prepared for:      ISTP Project")
    # produces a large gap on ONE line, not a real column boundary spanning
    # most of the page.
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = Path(tmp_dir) / "label_value.pdf"
        c = rl_canvas.Canvas(str(path), pagesize=letter)
        c.setFont("Helvetica", 12)
        c.drawString(72, 700, "Prepared for:")
        c.drawString(300, 700, "ISTP Project")
        c.drawString(72, 680, "A single normal body paragraph below the label/value line.")
        c.save()
        result = load_pdf(str(path))

    assert not any(b.kind == BlockKind.NOTE and "multi-column" in b.text for b in result.blocks)
```

- [ ] **Step 2: Run tests to verify they fail/pass as expected**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -k "multi_column" -v`
Expected: the first test FAILS (no detection wired up yet); the other two should already PASS today (nothing flags anything today) — confirm and note, since implementing this task incorrectly (e.g. using the naive "largest gap" heuristic explicitly rejected by the design) could make these regress.

- [ ] **Step 3: Implement the fix**

Apply `_detect_suspected_column_gap` and its wiring exactly as shown, using `page_lines` (the table-filtered line list) and `table_bboxes`.

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_pdf_loader.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/pdf_loader.py ingestion/tests/test_pdf_loader.py
git commit -m "feat(pdf_loader): flag suspected multi-column pages with a NOTE marker (detection only, no automatic split)"
```

---

## Task 10: Phase 6a — Ingestion-side `primer_context` threading

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py` (`build_survey_tree`, `_combine_global_context`, `_build_survey_tree_for_branch`'s call site), `ingestion/app/main.py` (`/level` route, `_build_survey_tree_with_scoring`)
- Test: `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: nothing new from other tasks — this task only adds a new optional string parameter end-to-end through the existing chain.
- Produces: `build_survey_tree(..., primer_context: str | None = None)` — new trailing optional parameter. `_combine_global_context(base, branch_index, glossary_sections, primer_context=None)` — extended signature.

`_combine_global_context`'s current exact code (`llm_leveling.py:724-730`):

```python
def _combine_global_context(
    base: str | None, branch_index: int, glossary_sections: list[tuple[int, str, str]]
) -> str | None:
    extra = _glossary_context_for_branch(branch_index, glossary_sections)
    if extra is None:
        return base
    return f"{base}\n\n{extra}" if base else extra
```

Change to:

```python
def _combine_global_context(
    base: str | None, branch_index: int, glossary_sections: list[tuple[int, str, str]],
    primer_context: str | None = None,
) -> str | None:
    extra = _glossary_context_for_branch(branch_index, glossary_sections)
    parts = [part for part in (base, extra, primer_context) if part]
    return "\n\n".join(parts) if parts else None
```

Add `primer_context: str | None = None` as a new trailing parameter to `build_survey_tree`'s signature (after `branch_concurrency: int = 1,` at the end of its current parameter list, `llm_leveling.py:1177-1196`).

Change the call site at `llm_leveling.py:1779`:

```python
                global_context=_combine_global_context(global_context, branch_index, glossary_sections),
```

to:

```python
                global_context=_combine_global_context(global_context, branch_index, glossary_sections, primer_context),
```

In `main.py`'s `/level` route (`~lines 854-916`), add `primer_context: str | None = None` as a new trailing query param (after `job_id: str | None = None,`), and thread it into `_build_survey_tree_with_scoring`'s call at the end of the route body — change:

```python
        return await run_in_threadpool(
            _build_survey_tree_with_scoring, doc, client, customer_id, user_id, catalog, job_id, model
        )
```

to:

```python
        return await run_in_threadpool(
            _build_survey_tree_with_scoring, doc, client, customer_id, user_id, catalog, job_id, model, primer_context
        )
```

And extend `_build_survey_tree_with_scoring`'s own signature (`main.py:369-376`) with `primer_context: str | None = None` as a new trailing parameter, threading it into its own `build_survey_tree(...)` call (add `primer_context=primer_context,` to that call's kwargs).

- [ ] **Step 1: Write the failing test**

```python
def test_build_survey_tree_threads_primer_context_into_every_branch(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_two_branch_doc(), fake, primer_context="This document specifies an avionics interface.")
    assert len(fake.calls) == 2
    for call in fake.calls:
        assert "This document specifies an avionics interface." in call["section_text"]


def test_build_survey_tree_defaults_primer_context_to_none_byte_identical() -> None:
    # None (the default) must be byte-identical to before this capability
    # existed -- same convention as every other optional *_client param.
    tree_without = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    tree_with_none = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), primer_context=None)
    assert tree_without.nodes == tree_with_none.nodes
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -k "primer_context" -v`
Expected: FAIL — `build_survey_tree() got an unexpected keyword argument 'primer_context'`.

- [ ] **Step 3: Implement the fix**

Apply the four changes shown above (`_combine_global_context`'s new signature, `build_survey_tree`'s new trailing param, the call-site update at line 1779, and the `main.py` route + wrapper threading).

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -v`
Expected: all PASS — every pre-existing test omits `primer_context` entirely and must be unaffected (it defaults to `None`).

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/app/main.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(llm_leveling): thread optional primer_context string into every branch's global_context"
```

---

## Task 11: Phase 6b — Orchestrator `OpenWebUiClient` file-upload methods

**Files:**
- Modify: `orchestrator/src/modules/llm/openwebui.client.ts`, `orchestrator/src/config/config.schema.ts`
- Test: `orchestrator/test/openwebui.client.spec.ts`

**Interfaces:**
- Consumes: `nativeOllamaHeaders()` (existing private method, confirmed at `openwebui.client.ts` lines 213-218), the existing raw-`fetch` pattern `embed()`/`showModel()` already use.
- Produces: `uploadFile(buffer: Buffer, filename: string): Promise<string>` (returns the uploaded file's `id`), `pollFileProcessed(fileId: string, timeoutMs: number): Promise<boolean>` (returns `true` once `status === 'completed'`, `false` on `'failed'` or timeout — never throws), `deleteFile(fileId: string): Promise<void>` (best-effort, swallows its own errors — cleanup must never mask the primer's real result or throw past the caller).

New config keys, following the exact `EMBED_PATH`/`SHOW_PATH` convention (`config.schema.ts:49,56`):

```ts
  FILES_UPLOAD_PATH: z.string().default('/api/v1/files/'),
  FILES_STATUS_PATH: z.string().default('/api/v1/files'),  // + `/${id}/process/status`
```

Add these two keys to `config.schema.ts` alongside the existing `EMBED_PATH`/`SHOW_PATH` block, and to `OpenWebUiClientConfig` (the interface at `openwebui.client.ts:24-36`).

```ts
// New imports at the top of openwebui.client.ts if not already present:
// (FormData/Blob are global in Node 18+, no import needed)

async uploadFile(buffer: Buffer, filename: string): Promise<string> {
  const baseUrl = this.config.LLM_BASE_URL.replace(/\/v1\/?$/, '');
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  const response = await fetch(`${baseUrl}${this.config.FILES_UPLOAD_PATH}`, {
    method: 'POST',
    headers: this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {},
    body: form,
  });
  if (!response.ok) {
    throw new Error(`OpenWebUiClient.uploadFile failed: ${response.status}`);
  }
  const data = (await response.json()) as { id: string };
  return data.id;
}

async pollFileProcessed(fileId: string, timeoutMs: number): Promise<boolean> {
  const baseUrl = this.config.LLM_BASE_URL.replace(/\/v1\/?$/, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${baseUrl}${this.config.FILES_STATUS_PATH}/${fileId}/process/status`,
        { headers: this.nativeOllamaHeaders() },
      );
      if (response.ok) {
        const data = (await response.json()) as { status?: string };
        if (data.status === 'completed') return true;
        if (data.status === 'failed') return false;
      }
    } catch {
      // A transient poll failure is not itself a verdict -- keep polling
      // until the deadline, then time out the same as a stuck 'pending'.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async deleteFile(fileId: string): Promise<void> {
  const baseUrl = this.config.LLM_BASE_URL.replace(/\/v1\/?$/, '');
  try {
    await fetch(`${baseUrl}${this.config.FILES_STATUS_PATH}/${fileId}`, {
      method: 'DELETE',
      headers: this.nativeOllamaHeaders(),
    });
  } catch {
    // Best-effort cleanup -- a delete failure must never mask the
    // primer's already-resolved result or throw past the caller.
  }
}
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('OpenWebUiClient.uploadFile', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:3000/v1',
    LLM_API_KEY: 'test-key',
    LLM_CHAT_MODEL: 'test-model',
    LLM_TRUSTED_LOCAL: true,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_MODEL: 'test-embed',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 5000,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uploads a file and returns its id', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ id: 'file-123' }) });
    const client = new OpenWebUiClient(config);
    const id = await client.uploadFile(Buffer.from('pdf bytes'), 'doc.pdf');
    expect(id).toBe('file-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/files/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the upload response is not ok', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new OpenWebUiClient(config);
    await expect(client.uploadFile(Buffer.from('x'), 'x.pdf')).rejects.toThrow();
  });
});

describe('OpenWebUiClient.pollFileProcessed', () => {
  const config = { /* same as above */ } as OpenWebUiClientConfig;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('returns true once status is completed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ status: 'completed' }) });
    const client = new OpenWebUiClient(config);
    const result = await client.pollFileProcessed('file-123', 5000);
    expect(result).toBe(true);
  });

  it('returns false when status is failed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ status: 'failed' }) });
    const client = new OpenWebUiClient(config);
    const result = await client.pollFileProcessed('file-123', 5000);
    expect(result).toBe(false);
  });

  it('returns false on timeout rather than throwing', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ status: 'pending' }) });
    const client = new OpenWebUiClient(config);
    const result = await client.pollFileProcessed('file-123', 100);
    expect(result).toBe(false);
  });
});

describe('OpenWebUiClient.deleteFile', () => {
  const config = { /* same as above */ } as OpenWebUiClientConfig;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('does not throw when the delete request fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network error'));
    const client = new OpenWebUiClient(config);
    await expect(client.deleteFile('file-123')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npm test -- openwebui.client.spec.ts`
Expected: FAIL — `uploadFile`/`pollFileProcessed`/`deleteFile` are not defined on `OpenWebUiClient`.

- [ ] **Step 3: Implement the fix**

Add the three methods and the two new config keys shown above.

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd orchestrator && npm test -- openwebui.client.spec.ts config.schema.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/llm/openwebui.client.ts orchestrator/src/config/config.schema.ts orchestrator/test/openwebui.client.spec.ts
git commit -m "feat(openwebui.client): add uploadFile/pollFileProcessed/deleteFile for the whole-document primer"
```

---

## Task 12: Phase 6c — Orchestrator worker wiring + caching

**Files:**
- Modify: `orchestrator/src/modules/pipeline/pipeline.worker.ts`, `orchestrator/src/modules/pipeline/jobs.module.ts` (new Redis-backed cache provider, following the `jobs.module.ts:108` pattern)
- Test: `orchestrator/test/pipeline.worker.spec.ts` (confirm exact filename first — grep `orchestrator/test/` for the existing worker test file before writing this task's steps)

**Interfaces:**
- Consumes: `deps.openWebUiClient.uploadFile`/`pollFileProcessed`/`deleteFile` (Task 11), `deps.ingestionClient.level(...)` (existing, extended with a new trailing `primerContext` argument).
- Produces: no new exported function — this task wires the primer call into the existing `runPipelineJob` flow between `/ingest` and `/level`.

Per the design's own gating rules: skip when the document already fits in one call (mirrored from `fits_whole_document`/glossary-inlining's own gate — the orchestrator doesn't have direct access to that ingestion-side computation, so gate on a proxy instead: skip the primer for a document under a size threshold, e.g. `job.fileBuffer.byteLength` below some small-document floor — this is an intentional simplification versus the exact ingestion-side gate, since the orchestrator makes this decision BEFORE `/ingest` has even run). Cache by content hash using a NEW Redis connection following `jobs.module.ts`'s own `new Redis(config.get<string>('REDIS_URL')!)` + `redis.on('error', ...)` pattern (no shared instance exists to reuse, confirmed).

```ts
// New provider in jobs.module.ts, alongside the existing Redis providers
// (same pattern as JobEventsPublisher's own provider at line ~105-112):
{
  provide: 'PRIMER_CACHE_REDIS',
  useFactory: (config: ConfigService) => {
    const redis = new Redis(config.get<string>('REDIS_URL')!);
    redis.on('error', (err) => console.error('PrimerCache Redis error:', err));
    return redis;
  },
  inject: [ConfigService],
},
```

In `pipeline.worker.ts`, between the `/ingest` call (ends line 335) and the `/level` call (line 397) — following the exact fail-open idiom the existing `linkTypeCatalog` block already uses (lines 367-371):

```ts
    let primerContext: string | undefined;
    try {
      const contentHash = crypto.createHash('sha256').update(job.fileBuffer).digest('hex');
      const cacheKey = `primer:${model ?? 'default'}:${contentHash}`;
      const cached = await deps.primerCacheRedis.get(cacheKey);
      if (cached !== null) {
        primerContext = cached;
      } else {
        const fileId = await deps.openWebUiClient.uploadFile(job.fileBuffer, job.filename);
        try {
          const processed = await deps.openWebUiClient.pollFileProcessed(fileId, 60_000);
          if (processed) {
            const result = await deps.openWebUiClient.chat(
              [{
                role: 'user',
                content:
                  'Read the attached document in full. In 2-3 short sentences, describe: the ' +
                  'document type and purpose, the system it specifies (if any), and the domain ' +
                  "conventions or phrasing style it uses. Do not list sections or definitions.",
              }],
              { files: [{ type: 'file', id: fileId }] } as any,
            );
            primerContext = result.content?.trim() || undefined;
            if (primerContext) {
              await deps.primerCacheRedis.set(cacheKey, primerContext, 'EX', 86_400);
            }
          }
        } finally {
          await deps.openWebUiClient.deleteFile(fileId);
        }
      }
    } catch (err) {
      // Fail-open, same convention as linkTypeCatalog just below -- a
      // primer failure must never block or fail the job.
      primerContext = undefined;
    }
```

**Note for the implementer**: `deps.openWebUiClient.chat`'s `opts` parameter shape (`{ files: [...] }`) is a NEW field this task's Task 11 sibling (`chat()`'s existing `buildParams`) does NOT yet forward — `chat()`'s current `buildParams` (per Task 11's research) only forwards `model`/`temperature`/`response_format`/`max_tokens`/`options`/`reasoning_effort`/`tools`/`tool_choice`. A `files` field must be ADDED to `chat()`'s own `buildParams` (in `openwebui.client.ts`, the same object Task 11 already touches) as part of THIS task — add `...(opts?.files !== undefined ? { files: opts.files } : {}),` to `buildParams`'s spread list, and add `files?: { type: 'file' | 'collection'; id: string }[]` to the `LlmChatOptions` interface (wherever it's defined — check `llm-client.interface.ts`, confirmed present in the earlier file-listing grep). Remove the `as any` cast shown above once this is done properly.

Thread `primerContext` into the `/level` call (line 397's `deps.ingestionClient.level(...)`) as a new trailing argument, and into `IngestionHttpClient.level`'s own signature/query-string construction (in `ingestion-http.client.ts` — read that file's existing `level` method first to match its exact query-param-building convention before adding `primer_context` to it).

- [ ] **Step 1: Write the failing test**

```ts
it('threads primerContext from a successful upload+chat into the level() call', async () => {
  const deps = buildTestDeps({
    openWebUiClient: {
      uploadFile: jest.fn().mockResolvedValue('file-1'),
      pollFileProcessed: jest.fn().mockResolvedValue(true),
      chat: jest.fn().mockResolvedValue({ content: 'This is an avionics ICD.' }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    },
    primerCacheRedis: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
  });
  await runPipelineJob(buildTestJob(), deps);
  expect(deps.ingestionClient.level).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    expect.anything(), expect.anything(), expect.anything(),
    'This is an avionics ICD.',
  );
  expect(deps.openWebUiClient.deleteFile).toHaveBeenCalledWith('file-1');
});

it('fails open to undefined primerContext when upload throws', async () => {
  const deps = buildTestDeps({
    openWebUiClient: { uploadFile: jest.fn().mockRejectedValue(new Error('network error')) },
    primerCacheRedis: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
  });
  await runPipelineJob(buildTestJob(), deps);
  expect(deps.ingestionClient.level).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    expect.anything(), expect.anything(), expect.anything(),
    undefined,
  );
});

it('reads from the primer cache instead of re-uploading on a cache hit', async () => {
  const deps = buildTestDeps({
    openWebUiClient: { uploadFile: jest.fn() },
    primerCacheRedis: { get: jest.fn().mockResolvedValue('cached primer text'), set: jest.fn() },
  });
  await runPipelineJob(buildTestJob(), deps);
  expect(deps.openWebUiClient.uploadFile).not.toHaveBeenCalled();
});
```

(`buildTestDeps`/`buildTestJob` are placeholders for whatever test-double-construction helpers `pipeline.worker.spec.ts` already uses — read that file's existing tests first and match its real helper names/shapes exactly; do not invent new ones if equivalents already exist.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npm test -- pipeline.worker.spec.ts`
Expected: FAIL — `deps.primerCacheRedis` and the primer wiring don't exist yet.

- [ ] **Step 3: Implement the fix**

Apply the `jobs.module.ts` Redis provider, the `pipeline.worker.ts` wiring block, the `chat()`/`LlmChatOptions` `files` field addition, and the `IngestionHttpClient.level`/`main.py` route threading (read `ingestion-http.client.ts` first to match its real conventions).

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd orchestrator && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/modules/pipeline/ orchestrator/src/modules/llm/ orchestrator/src/config/ orchestrator/test/
git commit -m "feat(pipeline.worker): wire whole-document primer between /ingest and /level, cache by content hash"
```

---

## Self-Review Notes

**Spec coverage:** Task 1 (OCR figures bug) and Task 2 (Phase 0+1, combined per the spec's own mandate) cover the root-cause fix. Task 3 covers Phase 2 (heading detection, all four layered signals + watermark exclusion). Task 4 covers the spec's Testing section's golden-fixture/docx_pagination regression requirement explicitly, as its own task rather than folded silently into another. Tasks 5-7 cover Phase 3 (cross-page merge, caption, borderless+border_style fix) as three right-sized sub-tasks rather than one large one, since a reviewer could accept/reject each independently. Task 8 covers Phase 4 (AcroForm). Task 9 covers Phase 5 (multi-column, flag-only as specified). Tasks 10-12 cover Phase 6 (ingestion threading, orchestrator client methods, orchestrator worker wiring+caching) as three sub-tasks split by service/concern boundary.

**Placeholder scan:** Task 5 and Task 6 both flagged their own draft-code placeholders explicitly (`prev_xs = sorted(...) if False`, `"pending_table_caption" in dir()`) as things NOT to ship, with the corrected real code given immediately after — this is intentional scaffolding showing the reasoning that led to the final correct code, not a plan failure, since the actual code an implementer executes is the corrected version in each case, given in full. Task 12 explicitly flags `buildTestDeps`/`buildTestJob` as placeholders for existing test helpers to be matched against the real file, since this plan's author has not read `pipeline.worker.spec.ts` directly — the step itself instructs reading that file first, not shipping an invented helper.

**Type consistency:** `_lines_to_paragraphs`'s return shape changes from a 2-tuple (Task 2) to a 4-tuple (Task 3) — Task 3 explicitly calls this out and instructs updating Task 2's own test assertions to match, since both tasks land in the same linear plan before any test suite run needs to reconcile them. `_build_pdf_table_grid`'s return type changes from a 2-tuple to a 3-tuple in Task 5 (adding `xs`) and Task 7 builds on that same 3-tuple, not re-changing it. `_combine_global_context`'s signature (Task 10) is additive-only (`primer_context` defaults to `None`), consistent with every other optional-capability convention this plan's Global Constraints section requires.

**Sequencing dependency confirmed real:** Task 3 depends on Task 2's `_lines_to_paragraphs`/`_line_size`/`_line_is_bold`. Tasks 5-9 are independent of each other and of Task 3 (they touch table/form/column concerns Task 3 doesn't touch), but all depend on Task 2 having landed (the per-page loop's overall shape). Task 4 must run after Task 3 (it verifies Tasks 2-3's combined regression risk) and before Tasks 5-9 begin, so any golden-fixture/pagination regression is caught before further changes compound on top of it. Tasks 10-12 have no dependency on Tasks 1-9 at all (Phase 6 is format-agnostic) and could in principle run in parallel with them — sequenced last in this plan only because the design spec's own "measure Phase 0+1 first" sequencing note applies to the DECISION to build Phase 6, which was already made when this plan was approved, not to an implementation-order requirement.
