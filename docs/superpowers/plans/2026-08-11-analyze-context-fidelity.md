# Analyze-Stage Context Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the docx loader's structural blind spots (headings, lists, embedded content, numbering) and the SURVEY analyze stage's cross-branch context gaps (incomplete outline, no glossary sharing) so requirement analysis sees the document's real structure instead of a silently-degraded approximation of it.

**Architecture:** Two independent components, implemented in sequence (Component 2 improves the block classification Component 1 consumes). Component 2 touches only `ingestion/app/loaders/docx_loader.py` (the docx→canonical-model parser). Component 1 touches only `ingestion/app/leveling/llm_leveling.py` (the SURVEY branch-analysis orchestrator). Neither component changes the canonical `Block`/`Table`/`Figure` schema (`app/canonical/model.py`) — `BlockKind.LIST_ITEM`/`NOTE` and `Block.number_label` already exist, just unused by the loader today.

**Tech Stack:** Python 3.11+, `python-docx` 1.1.2 (raw `lxml`/oxml element access for OOXML structures python-docx's high-level API doesn't expose: `w:outlineLvl`, `w:numPr`, `w:sdt`, `w:altChunk`, `w:object`/VML), `pytest` (existing suite conventions: `ingestion/tests/test_docx_loader.py`, `ingestion/tests/test_llm_leveling.py`).

> **Revision note (2026-08-13):** re-verified against the repo's current state after the "table-fidelity" initiative landed (commits `32ae04a`..`419dbc7`, 2026-08-12, `docs/superpowers/specs/2026-08-12-table-fidelity-design.md`), which changed `Table.rows: list[list[str]]` to `Table.cells: list[list[TableCell | None]]` (rich per-cell styling: colspan/rowspan/is_header/bold/colors/align) and grew `docx_loader.py` from 188 to 761 lines. Confirmed via full re-read of the current `docx_loader.py`/`llm_leveling.py`/`tree_builder.py`: **Tasks 2-6, 8, 9, 10, 11 are unaffected** (Task 10 only needed a cosmetic line-number bump, `_build_document_outline` moved 639→641). **Tasks 1 and 7 are rewritten below** to target the actual current `cells`-based table construction instead of the old `rows`-based one that no longer exists. The Architecture line above ("neither component changes the canonical schema") still holds for THIS plan's own edits — the schema change came from the separate table-fidelity work, not from anything in this plan.

## Global Constraints

- Run tests via `cd ingestion && .venv/bin/python -m pytest tests/<file>.py -v` (from the `ingestion/` directory — `pytest.ini` sets `testpaths = tests`, `pythonpath = .`).
- No change to `app/canonical/model.py` — reuse the existing `BlockKind.LIST_ITEM`, `BlockKind.NOTE`, `Block.number_label` fields.
- Every new XML-structure check must degrade gracefully to today's pre-fix classification for that one element (never abort the whole document load) — per the design's fail-loud, not fail-silent-or-fail-hard, principle.
- Minimal diffs: each task modifies only the function(s) named in its **Files** block. Do not reformat, reorder, or rename anything not directly touched by that task's change.
- Commit after each task (per-task commit, not one giant commit at the end) — but per this session's global rule, commits are the human's call; each task ends with a `git add`/`git commit` step written out, execute it only if the operator confirms commits are wanted for this work.

---

## Component 2: docx loader fidelity (`ingestion/app/loaders/docx_loader.py`)

### Task 1: Refactor body walk into recursive nested functions + `w:sdt` unwrap

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (`load_docx`, currently lines ~614-761 — the body-walk loop and its two branches; the module also has ~600 lines of pre-existing table-fidelity helper functions above `load_docx` that this task does not touch, e.g. `_extract_table_cells`, `_column_widths`, `_table_border_style`, `_row_is_header`, `_cell_is_bold`)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Consumes: `_extract_table_cells(docx_table) -> list[list[TableCell | None]]`, `_column_widths(docx_table)`, `_table_border_style(docx_table)` — pre-existing module-level functions (landed by the table-fidelity initiative, 2026-08-12), unchanged by this task, just relocated into `_handle_table`'s closure body. `load_docx(path, describe_figure=None) -> CanonicalDoc` signature is unchanged.
- Produces: `load_docx` internals are now three nested functions (`_walk_body_elements`, `_handle_paragraph`, `_handle_table`) closing over `blocks`/`tables`/`figures`/`consumed_rel_ids` (mutable lists/set, mutated via `.append`/`.add`) and `block_id`/`table_index`/`figure_index`/`offset` (ints, mutated via `nonlocal`). Every later task in this plan adds code inside `_handle_paragraph` or `_handle_table` — their code blocks below assume these two functions exist with this exact signature (`_handle_paragraph(child) -> None`, `_handle_table(child) -> None`, both closures with no return value).

This is a pure structural refactor — behavior must be byte-identical before and after (verified by the full existing test suite passing), except for the new capability: a `w:sdt` (content control) wrapping paragraphs/tables no longer makes them vanish.

- [ ] **Step 1: Write the failing test**

Add to `ingestion/tests/test_docx_loader.py`:

```python
def test_load_docx_unwraps_content_control_wrapped_heading_and_paragraph() -> None:
    # Regression: a w:sdt (content control) subtree was previously skipped
    # whole by the body walk (it matches neither w:p nor w:tbl at the top
    # level) -- any heading/paragraph a template wraps in one (common for
    # locked/protected sections) vanished with no trace.
    from docx import Document as DocxDocument
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls

    doc = DocxDocument()
    doc.add_paragraph("Before the content control.")
    sdt_xml = (
        f'<w:sdt {nsdecls("w")}>'
        "<w:sdtContent>"
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
        "<w:r><w:t>Hidden Heading</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Hidden paragraph text.</w:t></w:r></w:p>"
        "</w:sdtContent></w:sdt>"
    )
    doc.element.body.append(parse_xml(sdt_xml))
    doc.add_paragraph("After the content control.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "sdt.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    texts = [b.text for b in result.blocks]
    assert "Hidden Heading" in texts
    assert "Hidden paragraph text." in texts
    heading_block = next(b for b in result.blocks if b.text == "Hidden Heading")
    assert heading_block.kind == BlockKind.HEADING
    assert heading_block.heading_level == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py::test_load_docx_unwraps_content_control_wrapped_heading_and_paragraph -v`
Expected: FAIL — `"Hidden Heading"` and `"Hidden paragraph text."` are not in `texts` (the `w:sdt` subtree is silently skipped by the current body walk).

- [ ] **Step 3: Implement the refactor**

Replace the body of `load_docx` (from the `for child in docx_doc.element.body.iterchildren():` loop through the end of the `w:tbl` branch, i.e. lines 72-159) with:

```python
    def _walk_body_elements(elements) -> None:
        for child in elements:
            if child.tag == qn("w:p"):
                _handle_paragraph(child)
            elif child.tag == qn("w:tbl"):
                _handle_table(child)
            elif child.tag == qn("w:sdt"):
                sdt_content = child.find(qn("w:sdtContent"))
                if sdt_content is not None:
                    _walk_body_elements(sdt_content.iterchildren())

    def _handle_paragraph(child) -> None:
        nonlocal block_id, figure_index, offset
        paragraph = DocxParagraph(child, docx_doc)
        content = paragraph.text.strip()
        blip_elements = child.findall(f".//{qn('a:blip')}")
        embed_ids = [embed_id for b in blip_elements if (embed_id := b.get(qn("r:embed")))]

        if not content and not embed_ids:
            return

        if content:
            start = offset
            end = start + len(content)
            offset = end + 1

            style_name = paragraph.style.name if paragraph.style else ""
            if style_name.startswith(_STYLE_HEADING_PREFIX):
                level = int(style_name.removeprefix(_STYLE_HEADING_PREFIX))
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.HEADING,
                        text=content,
                        heading_level=level,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
            else:
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.PARAGRAPH,
                        text=content,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
            block_id += 1

        for embed_id in embed_ids:
            rel = docx_doc.part.rels.get(embed_id)
            if rel is None or _IMAGE_RELTYPE_MARKER not in rel.reltype:
                continue
            consumed_rel_ids.add(embed_id)
            caption = _describe_one_figure(rel, describe_figure)
            start = offset
            end = start + 1
            offset = end
            figures.append(
                Figure(
                    id=f"f{figure_index}",
                    caption=caption,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.FIGURE,
                    text=f"[FIGURE: {caption or 'none'}]",
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            block_id += 1
            figure_index += 1

    def _handle_table(child) -> None:
        nonlocal table_index, offset
        docx_table = DocxTable(child, docx_doc)
        cells = _extract_table_cells(docx_table)
        start = offset
        end = start + 1
        offset = end
        tables.append(
            Table(
                id=f"t{table_index}",
                cells=cells,
                column_widths=_column_widths(docx_table),
                border_style=_table_border_style(docx_table),
                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
            )
        )
        table_index += 1

    _walk_body_elements(docx_doc.element.body.iterchildren())
```

This is a pure move of the existing `w:p`/`w:tbl` handling into two nested functions plus the new `w:sdt` branch — no other logic changes in this task. `_handle_table`'s body is the table-fidelity initiative's CURRENT construction (`_extract_table_cells`/`_column_widths`/`_table_border_style`, all pre-existing module-level functions this task does not modify) — not the older `rows=[[cell.text...]]` shape this plan was originally written against; `Table.rows` no longer exists on the schema.

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS, including the new `test_load_docx_unwraps_content_control_wrapped_heading_and_paragraph`.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "refactor(docx_loader): recursive body walk, unwrap w:sdt content controls"
```

---

### Task 2: Robust heading detection (`w:outlineLvl` + regex style-name fallback + `Title`)

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (constants near line 17, `_handle_paragraph`'s heading branch from Task 1)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Produces: `_heading_level_for_paragraph(paragraph: DocxParagraph) -> int | None`, module-level function. Returns `None` for a non-heading paragraph, else the 1-based heading level. Later tasks (3, 4, 9) call this to decide "is this paragraph a heading" before their own checks.

Today's detection (`style_name.startswith("Heading ")` then unguarded `int()`) misses: `docgen-json-to-word`'s no-space `"Heading3"` style names (silently → `PARAGRAPH`, no crash), any custom/localized heading style (silently → `PARAGRAPH`), `Title`-styled paragraphs (silently → `PARAGRAPH`), and crashes the entire document load on a custom style whose name starts with `"Heading "` but has a non-numeric suffix (e.g. `"Heading Body"` → `int("Body")` raises `ValueError`, uncaught). `w:outlineLvl` — the template-independent OOXML heading signal — is never consulted at all, even though it's what Word's own built-in `Heading N` styles actually carry (on the *style* definition, not the paragraph's own `pPr`, for the common case).

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_docx_loader.py`:

```python
def test_load_docx_detects_heading_via_style_level_outline_lvl_with_no_space_in_style_name() -> None:
    # Regression: docgen-json-to-word (the sibling repo that GENERATES real
    # .docx files) emits style ids like "Heading3" with NO space
    # (ParagraphService.cs), which the old startswith("Heading ") check
    # never matched -- silently downgraded to PARAGRAPH. Word's own
    # built-in Heading N styles carry their outlineLvl on the STYLE
    # definition (not the paragraph's own pPr), so this exercises that path.
    from docx import Document as DocxDocument

    doc = DocxDocument()
    paragraph = doc.add_paragraph("Backplane Power")
    paragraph.style = doc.styles["Heading 3"]  # style_id "Heading3", name "Heading 3"

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "heading3.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    heading = next(b for b in result.blocks if b.text == "Backplane Power")
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 3


def test_load_docx_treats_title_style_as_a_heading() -> None:
    from docx import Document as DocxDocument

    doc = DocxDocument()
    paragraph = doc.add_paragraph("AirPro Interface Control Document")
    paragraph.style = doc.styles["Title"]

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "title.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    heading = next(b for b in result.blocks if "Interface Control" in b.text)
    assert heading.kind == BlockKind.HEADING
    assert heading.heading_level == 1


def test_load_docx_does_not_crash_on_a_custom_heading_style_with_non_numeric_suffix() -> None:
    # Regression: a custom style named "Heading Body" (starts with "Heading "
    # but has no trailing digit) previously crashed the WHOLE document load
    # via int("Body") -- one malformed style aborted every other block too.
    from docx import Document as DocxDocument
    from docx.enum.style import WD_STYLE_TYPE

    doc = DocxDocument()
    doc.styles.add_style("Heading Body", WD_STYLE_TYPE.PARAGRAPH)
    paragraph = doc.add_paragraph("Not a real numbered heading.")
    paragraph.style = doc.styles["Heading Body"]
    doc.add_paragraph("A normal paragraph after it.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "custom_style.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))  # must not raise

    custom = next(b for b in result.blocks if b.text == "Not a real numbered heading.")
    assert custom.kind == BlockKind.PARAGRAPH  # no reliable level signal -- falls through, not a crash
    normal = next(b for b in result.blocks if b.text == "A normal paragraph after it.")
    assert normal.kind == BlockKind.PARAGRAPH
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py -k "heading3 or title_style or non_numeric_suffix" -v`
Expected: the first two FAIL (both blocks come back as `PARAGRAPH`); the third currently raises `ValueError` inside `load_docx` (uncaught), so pytest reports an ERROR, not a clean assertion failure.

- [ ] **Step 3: Implement the fix**

Replace `_STYLE_HEADING_PREFIX = "Heading "` (line 17) with:

```python
_HEADING_STYLE_PATTERN = re.compile(r"^Heading\s*(\d+)$")
```

(add `import re` to the top-level imports). Add this new module-level function right after `_describe_one_figure`:

```python
def _outline_level_from_ppr(ppr) -> int | None:
    """w:outlineLvl is 0-based per the OOXML spec; this file's Block.
    heading_level is 1-based, matching every existing loader/test."""
    outline_lvl = ppr.find(qn("w:outlineLvl"))
    if outline_lvl is None:
        return None
    val = outline_lvl.get(qn("w:val"))
    if val is None:
        return None
    return int(val) + 1


def _heading_level_for_paragraph(paragraph: DocxParagraph) -> int | None:
    """Heading level via whichever signal is present, in order of
    reliability: (1) an explicit outlineLvl override on THIS paragraph's
    own pPr -- rare, but the most authoritative signal when present; (2)
    outlineLvl on the paragraph's STYLE definition -- what Word's own
    built-in Heading 1-9 styles actually carry (confirmed live: a
    "Heading 1"-styled paragraph has NO outlineLvl on its own pPr, only
    on the style's pPr), so this is what fires for the common case,
    template-independent of the style's NAME; (3) style-name regex
    fallback ("Heading" + optional space + digits, or "Title") for a
    template that defines neither outlineLvl location -- allows both the
    with-space Word convention ("Heading 1") and the no-space convention
    docgen-json-to-word emits ("Heading3"). Returns None (falls through to
    PARAGRAPH) for a style regex can't parse, e.g. a custom style like
    "Heading Body" -- never raises."""
    own_ppr = paragraph._p.pPr
    if own_ppr is not None:
        level = _outline_level_from_ppr(own_ppr)
        if level is not None:
            return level

    style = paragraph.style
    if style is not None:
        style_ppr = style.element.find(qn("w:pPr"))
        if style_ppr is not None:
            level = _outline_level_from_ppr(style_ppr)
            if level is not None:
                return level

    style_name = style.name if style else ""
    if style_name == "Title":
        return 1
    match = _HEADING_STYLE_PATTERN.match(style_name)
    if match:
        return int(match.group(1))
    return None
```

In `_handle_paragraph` (from Task 1), replace:

```python
            style_name = paragraph.style.name if paragraph.style else ""
            if style_name.startswith(_STYLE_HEADING_PREFIX):
                level = int(style_name.removeprefix(_STYLE_HEADING_PREFIX))
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.HEADING,
                        text=content,
                        heading_level=level,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
            else:
```

with:

```python
            heading_level = _heading_level_for_paragraph(paragraph)
            if heading_level is not None:
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.HEADING,
                        text=content,
                        heading_level=heading_level,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
            else:
```

(the `else:` branch's plain-`PARAGRAPH` append is unchanged).

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS, including all three new tests. In particular `test_load_docx_extracts_heading_levels` (the existing `"Heading 1"`/`"Heading 2"` regression test) must still pass unchanged — confirms the style-level-outlineLvl path reproduces today's behavior for standard headings.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "fix(docx_loader): detect headings via outlineLvl, guard against non-numeric custom styles"
```

---

### Task 3: List item detection (`w:numPr` → `LIST_ITEM`)

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (`_handle_paragraph`, the `else:` branch from Task 2)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Consumes: `_heading_level_for_paragraph` (Task 2) — a list-item check only runs when that returns `None` (heading always wins).
- Produces: no new function: `BlockKind.LIST_ITEM` (already exists in `app/canonical/model.py`) is now actually emitted by the docx loader for the first time.

- [ ] **Step 1: Write the failing test**

```python
def test_load_docx_detects_a_numbered_list_item_as_list_item_kind() -> None:
    # Regression: a numbered/bulleted paragraph (w:numPr present) was
    # always emitted as plain PARAGRAPH -- indistinguishable from body text.
    from docx import Document as DocxDocument
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls

    doc = DocxDocument()
    paragraph = doc.add_paragraph("First bullet item.")
    pPr = paragraph._p.get_or_add_pPr()
    num_pr = parse_xml(
        f'<w:numPr {nsdecls("w")}><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
    )
    pPr.append(num_pr)
    doc.add_paragraph("A normal paragraph, not a list item.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "list.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    bullet = next(b for b in result.blocks if b.text == "First bullet item.")
    assert bullet.kind == BlockKind.LIST_ITEM
    normal = next(b for b in result.blocks if b.text == "A normal paragraph, not a list item.")
    assert normal.kind == BlockKind.PARAGRAPH
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py::test_load_docx_detects_a_numbered_list_item_as_list_item_kind -v`
Expected: FAIL — `bullet.kind` is `PARAGRAPH`, not `LIST_ITEM`.

- [ ] **Step 3: Implement the fix**

In `_handle_paragraph`, change the `else:` branch (the non-heading case) from:

```python
            else:
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.PARAGRAPH,
                        text=content,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
```

to:

```python
            else:
                own_ppr = paragraph._p.pPr
                is_list_item = own_ppr is not None and own_ppr.find(qn("w:numPr")) is not None
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.LIST_ITEM if is_list_item else BlockKind.PARAGRAPH,
                        text=content,
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
```

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "feat(docx_loader): emit LIST_ITEM for w:numPr paragraphs instead of plain PARAGRAPH"
```

---

### Task 4: Link adjacent `Caption`-styled paragraphs to their figure

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (`_handle_paragraph`)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new function — changes `_handle_paragraph`'s content-branch to special-case a `Caption`-styled paragraph immediately following a `FIGURE`-kind block.

A `Caption`-styled paragraph today becomes an ordinary `PARAGRAPH` block sitting next to a separate `FIGURE` block whose `caption` stays whatever `describe_figure` produced (or `None`) — the human-authored caption never reaches the figure. A real caption is more trustworthy than a vision guess, so it always overrides.

- [ ] **Step 1: Write the failing test**

```python
def test_load_docx_links_a_caption_styled_paragraph_to_the_preceding_figure() -> None:
    from docx import Document as DocxDocument
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        doc = DocxDocument()
        image_path = tmp_path / "diagram.png"
        Image.new("RGB", (4, 4), color="green").save(image_path)
        doc.add_picture(str(image_path))
        caption_paragraph = doc.add_paragraph("Figure 1: Power distribution diagram.")
        caption_paragraph.style = doc.styles["Caption"]

        out_path = tmp_path / "captioned.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    assert len(result.figures) == 1
    assert result.figures[0].caption == "Figure 1: Power distribution diagram."
    figure_block = next(b for b in result.blocks if b.kind == BlockKind.FIGURE)
    assert figure_block.text == "[FIGURE: Figure 1: Power distribution diagram.]"
    # The caption paragraph itself is NOT also emitted as a separate PARAGRAPH block.
    assert not any(b.text == "Figure 1: Power distribution diagram." and b.kind == BlockKind.PARAGRAPH
                   for b in result.blocks)


def test_load_docx_caption_overrides_a_vision_generated_caption() -> None:
    from docx import Document as DocxDocument
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        doc = DocxDocument()
        image_path = tmp_path / "diagram.png"
        Image.new("RGB", (4, 4), color="green").save(image_path)
        doc.add_picture(str(image_path))
        caption_paragraph = doc.add_paragraph("Figure 1: Power distribution diagram.")
        caption_paragraph.style = doc.styles["Caption"]

        out_path = tmp_path / "captioned_with_vision.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path), describe_figure=lambda _b: "a vision-generated guess")

    assert result.figures[0].caption == "Figure 1: Power distribution diagram."
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py -k caption -v`
Expected: FAIL — the caption paragraph is emitted as its own `PARAGRAPH` block, and `result.figures[0].caption` is `None` (or the vision guess in the second test), not the caption text.

- [ ] **Step 3: Implement the fix**

In `_handle_paragraph`, insert a new branch BEFORE the existing heading/list/paragraph `if`/`else` (still inside `if content:`, right after `start`/`end`/`offset` are computed):

```python
            style_name = paragraph.style.name if paragraph.style else ""
            if style_name == "Caption" and blocks and blocks[-1].kind == BlockKind.FIGURE:
                figures[-1].caption = content
                blocks[-1].text = f"[FIGURE: {content}]"
            else:
                heading_level = _heading_level_for_paragraph(paragraph)
                if heading_level is not None:
                    ... # unchanged heading branch from Task 2
                else:
                    ... # unchanged list/paragraph branch from Task 3
            block_id += 1
```

Note `block_id += 1` must NOT execute for the Caption-linking branch (no new block was appended) — restructure so the existing `block_id += 1` (currently at the end of the `if content:` block, after the heading/else branches) only runs for the heading/list/paragraph branches. Concretely, the full `if content:` block becomes:

```python
        if content:
            start = offset
            end = start + len(content)
            offset = end + 1

            style_name = paragraph.style.name if paragraph.style else ""
            if style_name == "Caption" and blocks and blocks[-1].kind == BlockKind.FIGURE:
                figures[-1].caption = content
                blocks[-1].text = f"[FIGURE: {content}]"
            else:
                heading_level = _heading_level_for_paragraph(paragraph)
                if heading_level is not None:
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.HEADING,
                            text=content,
                            heading_level=heading_level,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                        )
                    )
                else:
                    own_ppr = paragraph._p.pPr
                    is_list_item = own_ppr is not None and own_ppr.find(qn("w:numPr")) is not None
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.LIST_ITEM if is_list_item else BlockKind.PARAGRAPH,
                            text=content,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                        )
                    )
                block_id += 1
```

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "feat(docx_loader): link Caption-styled paragraphs to their figure, overriding any vision caption"
```

---

### Task 5: Fail-loud marker for `w:altChunk` (embedded document by reference)

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (`_walk_body_elements`)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Produces: no new function — `_walk_body_elements` gains a third `elif` branch.

`w:altChunk` inlines an entire separate document by reference (Word expands it on open); today it matches neither `w:p` nor `w:tbl` at the top level of the body walk, so it's silently skipped — the whole referenced document (often the actual requirements source) vanishes with no marker at all.

- [ ] **Step 1: Write the failing test**

```python
def test_load_docx_emits_a_note_block_for_an_altchunk_instead_of_silently_dropping_it() -> None:
    from docx import Document as DocxDocument
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls

    doc = DocxDocument()
    doc.add_paragraph("Before the embedded document.")
    doc.element.body.append(
        parse_xml(f'<w:altChunk {nsdecls("w", "r")} r:id="rIdEmbeddedDoc"/>')
    )
    doc.add_paragraph("After the embedded document.")

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "altchunk.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))  # must not raise

    note_blocks = [b for b in result.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert "UNSUPPORTED" in note_blocks[0].text
    assert "altChunk" in note_blocks[0].text
    before_idx = next(i for i, b in enumerate(result.blocks) if b.text == "Before the embedded document.")
    after_idx = next(i for i, b in enumerate(result.blocks) if b.text == "After the embedded document.")
    note_idx = next(i for i, b in enumerate(result.blocks) if b.kind == BlockKind.NOTE)
    assert before_idx < note_idx < after_idx
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py::test_load_docx_emits_a_note_block_for_an_altchunk_instead_of_silently_dropping_it -v`
Expected: FAIL — `note_blocks` is empty (the `w:altChunk` element is silently skipped).

- [ ] **Step 3: Implement the fix**

In `_walk_body_elements`, add a third branch:

```python
    def _walk_body_elements(elements) -> None:
        nonlocal block_id, offset
        for child in elements:
            if child.tag == qn("w:p"):
                _handle_paragraph(child)
            elif child.tag == qn("w:tbl"):
                _handle_table(child)
            elif child.tag == qn("w:sdt"):
                sdt_content = child.find(qn("w:sdtContent"))
                if sdt_content is not None:
                    _walk_body_elements(sdt_content.iterchildren())
            elif child.tag == qn("w:altChunk"):
                start = offset
                end = start + 1
                offset = end
                blocks.append(
                    Block(
                        id=f"b{block_id}",
                        kind=BlockKind.NOTE,
                        text="[UNSUPPORTED: embedded document (altChunk) -- content not extracted]",
                        source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                    )
                )
                block_id += 1
```

(`_walk_body_elements` needs `nonlocal block_id, offset` added since Task 1 gave it none — it previously only dispatched to `_handle_paragraph`/`_handle_table`, which each declare their own `nonlocal`s; this new branch mutates `block_id`/`offset` directly in this function's own body.)

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "feat(docx_loader): emit a NOTE block for w:altChunk instead of silently dropping it"
```

---

### Task 6: Fail-loud marker for OLE-embedded objects + exclude their icon from the phantom-figure fallback sweep

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (constants near line 17-18, `_handle_paragraph`)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Consumes: `consumed_rel_ids` (existing set from Task 1's closures) — this task adds the OLE icon's rel id to it, same mechanism already used to prevent inline images from being double-counted by the fallback sweep (lines 161-186, unchanged by this task).
- Produces: no new function.

An OLE-embedded object (`w:object` wrapping a VML `v:shape`/`v:imagedata` icon reference + an `o:OLEObject` payload reference) today: the payload itself (`o:OLEObject`'s `r:id`, reltype `oleObject`/`package`, never `image`) is already invisible (not caught by the image-only fallback sweep, and not walked at the body level at all) — that part needs no code change, it's simply undetected today and stays undetected except for our new marker. But the icon image (`v:imagedata`'s `r:id`, reltype `image`) currently IS caught by the fallback sweep (lines 166-186: any rel with `"image"` in its reltype not already in `consumed_rel_ids`), producing a phantom `FIGURE` block for a 32×32 file-type icon. Fix: emit one `NOTE` block per OLE object (flagging it, with its `ProgID` if present) and mark its icon rel consumed so the fallback sweep skips it.

- [ ] **Step 1: Write the failing test**

```python
def test_load_docx_flags_an_ole_object_and_does_not_emit_its_icon_as_a_phantom_figure() -> None:
    from docx import Document as DocxDocument
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls
    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        doc = DocxDocument()
        doc.add_heading("Attachments", level=1)

        # Use add_picture to get a REAL image relationship registered on the
        # part, then grab its rId and strip the auto-inserted inline picture
        # paragraph -- the ONLY remaining reference to that image becomes the
        # OLE icon reference we build below, exactly mirroring how a real
        # OLE object's icon is the sole reference to its icon image part.
        icon_path = tmp_path / "icon.png"
        Image.new("RGB", (32, 32), color="white").save(icon_path)
        doc.add_picture(str(icon_path))
        auto_paragraph = doc.paragraphs[-1]
        blip = auto_paragraph._p.findall(f".//{{{docx_oxml_ns_uri('a')}}}blip")
        icon_rel_id = blip[0].get(f"{{{docx_oxml_ns_uri('r')}}}embed")
        auto_paragraph._p.getparent().remove(auto_paragraph._p)

        object_xml = (
            f'<w:p {nsdecls("w", "r")} '
            'xmlns:v="urn:schemas-microsoft-com:vml" '
            'xmlns:o="urn:schemas-microsoft-com:office:office">'
            "<w:r><w:object>"
            f'<v:shape><v:imagedata r:id="{icon_rel_id}"/></v:shape>'
            '<o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" r:id="rIdEmbedDummy"/>'
            "</w:object></w:r></w:p>"
        )
        doc.element.body.append(parse_xml(object_xml))

        out_path = tmp_path / "ole.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    note_blocks = [b for b in result.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert "UNSUPPORTED" in note_blocks[0].text
    assert "Excel.Sheet.12" in note_blocks[0].text
    # No phantom FIGURE for the icon image.
    assert not any(b.kind == BlockKind.FIGURE for b in result.blocks)
    assert result.figures == []
```

This test needs a tiny helper (add near the top of `ingestion/tests/test_docx_loader.py`, alongside the `FIXTURES` constant):

```python
def docx_oxml_ns_uri(prefix: str) -> str:
    from docx.oxml.ns import nsmap
    return nsmap[prefix]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py::test_load_docx_flags_an_ole_object_and_does_not_emit_its_icon_as_a_phantom_figure -v`
Expected: FAIL — `note_blocks` is empty, and `result.figures` has one entry (the phantom icon figure from the fallback sweep).

- [ ] **Step 3: Implement the fix**

Add module-level constants near `_STYLE_HEADING_PREFIX`'s replacement (Task 2's `_HEADING_STYLE_PATTERN`):

```python
_VML_IMAGEDATA_TAG = "{urn:schemas-microsoft-com:vml}imagedata"
_OFFICE_OLEOBJECT_TAG = "{urn:schemas-microsoft-com:office:office}OLEObject"
```

In `_handle_paragraph`, after the existing inline-image (`blip_elements`/`embed_ids`) handling loop, add:

```python
        for ole_object in child.findall(f".//{qn('w:object')}"):
            icon_data = ole_object.find(f".//{_VML_IMAGEDATA_TAG}")
            if icon_data is not None:
                icon_rel_id = icon_data.get(qn("r:id"))
                if icon_rel_id:
                    consumed_rel_ids.add(icon_rel_id)
            ole_meta = ole_object.find(f".//{_OFFICE_OLEOBJECT_TAG}")
            prog_id = ole_meta.get("ProgID") if ole_meta is not None else None
            start = offset
            end = start + 1
            offset = end
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.NOTE,
                    text=f"[UNSUPPORTED: embedded object ({prog_id or 'unknown type'}) -- content not extracted]",
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            block_id += 1
```

Place this loop AFTER the `for embed_id in embed_ids:` loop (so `consumed_rel_ids` already reflects any genuinely-inline images before this pass runs — order doesn't actually matter for correctness here since they're disjoint rel ids, but keeps new code visually grouped with the other rel-consuming logic).

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "feat(docx_loader): flag OLE-embedded objects with a NOTE, stop emitting their icon as a phantom figure"
```

---

### Task 7: Fail-loud marker for a nested table inside a table cell

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (`_extract_table_cells`, currently lines 477-583 — NOT `_handle_table`; the grid-building logic this task changes lives in this pre-existing module-level function, called BY `_handle_table`)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Produces: no new function — one line inside `_extract_table_cells`'s existing per-origin-cell loop changes.

> **Rewritten 2026-08-13** — the original version of this task targeted `Table.rows: list[list[str]]`, which no longer exists (see the plan-level revision note). The table-fidelity initiative replaced it with `Table.cells: list[list[TableCell | None]]`, built by `_extract_table_cells` (a pre-existing function, unrelated to Task 1's closure refactor — `_handle_table` just calls it). A `TableCell.text: str` field still exists, so the marker still has a natural home; it just has to be appended into that field on the already-constructed `TableCell`, not substituted for a raw string.

`DocxCell.text` (python-docx, read into `TableCell.text` at `_extract_table_cells` line ~573) joins only the cell's own direct-child paragraphs — a nested `<w:tbl>` inside a cell contributes nothing, silently, not even a truncated fragment, and the nested table is not emitted as its own top-level `Table` either (the body walk never descends into `w:tc`). `DocxCell.tables` (a public python-docx property, on the `cell` object `_extract_table_cells` already constructs at line 571 for every origin cell) lists any table nested directly in that cell. A cell can have BOTH real paragraph text and a nested table, so the marker is appended, not substituted — replacing would silently lose the cell's own real text.

- [ ] **Step 1: Write the failing test**

```python
def test_load_docx_flags_a_nested_table_in_a_cell_instead_of_silently_losing_it() -> None:
    from docx import Document as DocxDocument

    from app.canonical.model import plain_text_rows

    doc = DocxDocument()
    outer_table = doc.add_table(rows=1, cols=2)
    outer_table.rows[0].cells[0].text = "Outer cell A"
    outer_table.rows[0].cells[1].add_table(rows=1, cols=1)  # nested table, no text set

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "nested_table.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    assert len(result.tables) == 1
    rows = plain_text_rows(result.tables[0])
    assert rows[0][0] == "Outer cell A"
    assert rows[0][1] == "[UNSUPPORTED: nested table]"
    # The marker lands on the real TableCell object too (not just the
    # plain_text_rows projection) -- spans/bold/etc. are untouched by this
    # fix, only .text changes.
    assert result.tables[0].cells[0][1].text == "[UNSUPPORTED: nested table]"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py::test_load_docx_flags_a_nested_table_in_a_cell_instead_of_silently_losing_it -v`
Expected: FAIL — `rows[0][1]` is `""` (the empty nested-table-only cell's own, empty, direct-text), not the marker text.

- [ ] **Step 3: Implement the fix**

In `_extract_table_cells` (lines 562-583), change:

```python
            cell = DocxCell(tc, docx_table)
            row_cells[tc.grid_offset] = TableCell(
                text=cell.text.strip(),
                colspan=tc.grid_span,
                rowspan=tc.bottom - tc.top,
                is_header=is_header,
                bold=_cell_is_bold(cell),
                align=_cell_alignment(tc),
                background_color=_cell_background_color(tc),
                text_color=_cell_text_color(cell),
            )
```

to:

```python
            cell = DocxCell(tc, docx_table)
            cell_text = cell.text.strip()
            if cell.tables:
                cell_text = f"{cell_text}\n[UNSUPPORTED: nested table]".strip()
            row_cells[tc.grid_offset] = TableCell(
                text=cell_text,
                colspan=tc.grid_span,
                rowspan=tc.bottom - tc.top,
                is_header=is_header,
                bold=_cell_is_bold(cell),
                align=_cell_alignment(tc),
                background_color=_cell_background_color(tc),
                text_color=_cell_text_color(cell),
            )
```

(`.strip()` on the combined string handles the common case — an empty `cell_text` — cleanly, producing exactly `"[UNSUPPORTED: nested table]"` with no leading blank line, while still separating real cell text from the marker with a newline when both are present.)

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS — including every table-fidelity regression test already in the suite (`test_load_docx_grid_before_shifts_column_position`, `test_load_docx_detects_header_row_via_tblHeader`, the bold/color/border/column-width tests), since this change only appends to `.text` on a cell that has a nested table — colspan/rowspan/bold/align/colors are computed identically to before, untouched by this task.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "feat(docx_loader): flag a nested table in a cell instead of silently losing its content"
```

---

### Task 8: Fail-loud marker for text box content

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (`_handle_paragraph`)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Produces: no new function.

Text inside `w:txbxContent` (a text box/shape's own text frame, VML or DrawingML) is never walked — only its images survive (via the existing blip search, which already reaches into text boxes since it's a `.//` search). Text content is dropped with zero trace.

- [ ] **Step 1: Write the failing test**

```python
def test_load_docx_flags_text_box_content_instead_of_silently_dropping_it() -> None:
    from docx import Document as DocxDocument
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls

    doc = DocxDocument()
    doc.add_paragraph("Before the text box.")
    textbox_xml = (
        f'<w:p {nsdecls("w")} xmlns:v="urn:schemas-microsoft-com:vml">'
        "<w:r><w:pict><v:shape><v:textbox><w:txbxContent>"
        "<w:p><w:r><w:t>Text box body content.</w:t></w:r></w:p>"
        "</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>"
    )
    doc.element.body.append(parse_xml(textbox_xml))

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "textbox.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    note_blocks = [b for b in result.blocks if b.kind == BlockKind.NOTE]
    assert len(note_blocks) == 1
    assert "UNSUPPORTED" in note_blocks[0].text
    assert "text box" in note_blocks[0].text
    assert "Text box body content" in note_blocks[0].text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py::test_load_docx_flags_text_box_content_instead_of_silently_dropping_it -v`
Expected: FAIL — the paragraph has no direct-child text (`paragraph.text` doesn't reach into `w:txbxContent`), so `_handle_paragraph` returns early (`not content and not embed_ids`) and no block at all is emitted.

- [ ] **Step 3: Implement the fix**

In `_handle_paragraph`, right after computing `content = paragraph.text.strip()` and `blip_elements`/`embed_ids`, add a text-box text extraction pass and fold it into the early-return guard:

```python
        content = paragraph.text.strip()
        blip_elements = child.findall(f".//{qn('a:blip')}")
        embed_ids = [embed_id for b in blip_elements if (embed_id := b.get(qn("r:embed")))]
        textbox_texts = []
        for txbx_content in child.findall(f".//{qn('w:txbxContent')}"):
            run_texts = [t.text for t in txbx_content.findall(f".//{qn('w:t')}") if t.text]
            combined = "".join(run_texts).strip()
            if combined:
                textbox_texts.append(combined)

        if not content and not embed_ids and not textbox_texts:
            return
```

Then, after the existing `for embed_id in embed_ids:` loop (and after Task 6's OLE-object loop, if both tasks land in the same function — order between the two doesn't matter, they're disjoint element types), add:

```python
        for textbox_text in textbox_texts:
            start = offset
            end = start + 1
            offset = end
            preview = textbox_text[:40] + ("…" if len(textbox_text) > 40 else "")
            blocks.append(
                Block(
                    id=f"b{block_id}",
                    kind=BlockKind.NOTE,
                    text=f"[UNSUPPORTED: text box content -- {len(textbox_text)} chars not extracted: '{preview}']",
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            block_id += 1
```

(`nonlocal block_id, offset` are already declared at the top of `_handle_paragraph` from Task 1 — no new `nonlocal` needed.)

- [ ] **Step 4: Run test to verify it passes, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "feat(docx_loader): flag text box content instead of silently dropping it"
```

---

### Task 9: Synthesize heading numbers into `Block.number_label`

**Files:**
- Modify: `ingestion/app/loaders/docx_loader.py` (`load_docx`, `_handle_paragraph`)
- Test: `ingestion/tests/test_docx_loader.py`

**Interfaces:**
- Consumes: `_heading_level_for_paragraph` (Task 2), `app.leveling.numbering.parse_numbering` (existing — the guard against double-numbering a heading whose text already carries its own number).
- Produces: populates the existing, previously-unused `Block.number_label: str | None` field for headings synthesized a number for. Component 1's Task 10 (`_branch_heading_labels`) reads this field.

Word's own heading numbering (via `w:numPr` linked to a `numbering.xml` list definition) is never rendered as literal run text — `paragraph.text` never contains "3.4.2", only the visual number Word computes at render time. Synthesize the same dotted numbering while walking, using a per-level counter, skipping any heading whose text already starts with its own number (common in numbered-paragraph-style specs) so it's never double-numbered.

- [ ] **Step 1: Write the failing tests**

```python
def test_load_docx_synthesizes_heading_numbers_for_unnumbered_headings() -> None:
    from docx import Document as DocxDocument

    doc = DocxDocument()
    doc.add_heading("Introduction", level=1)
    doc.add_heading("Scope", level=2)
    doc.add_heading("Power", level=1)
    doc.add_heading("Backplane", level=2)
    doc.add_heading("Connectors", level=3)

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "unnumbered.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    headings = {b.text: b.number_label for b in result.blocks if b.kind == BlockKind.HEADING}
    assert headings["Introduction"] == "1"
    assert headings["Scope"] == "1.1"
    assert headings["Power"] == "2"
    assert headings["Backplane"] == "2.1"
    assert headings["Connectors"] == "2.1.1"


def test_load_docx_does_not_double_number_a_heading_that_already_has_its_own_number() -> None:
    from docx import Document as DocxDocument

    doc = DocxDocument()
    doc.add_heading("3.2 Backplane Power", level=1)

    with tempfile.TemporaryDirectory() as tmp_dir:
        out_path = Path(tmp_dir) / "already_numbered.docx"
        doc.save(str(out_path))
        result = load_docx(str(out_path))

    heading = next(b for b in result.blocks if b.kind == BlockKind.HEADING)
    assert heading.text == "3.2 Backplane Power"
    assert heading.number_label is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py -k "synthesizes_heading_numbers or double_number" -v`
Expected: FAIL — `heading.number_label` is `None` for every heading in the first test (never set today).

- [ ] **Step 3: Implement the fix**

Add `from app.leveling.numbering import parse_numbering` to the imports. In `load_docx`, alongside the other counters (`block_id = 0`, etc.), add:

```python
    heading_counters: list[int] = []
```

In `_handle_paragraph`'s heading branch (inside the `if heading_level is not None:` block from Task 2/4), compute the number label right before constructing the `Block`:

```python
                if heading_level is not None:
                    number_label = None
                    if parse_numbering(content)[0] is None:
                        while len(heading_counters) < heading_level:
                            heading_counters.append(0)
                        del heading_counters[heading_level:]
                        heading_counters[heading_level - 1] += 1
                        number_label = ".".join(str(n) for n in heading_counters)
                    blocks.append(
                        Block(
                            id=f"b{block_id}",
                            kind=BlockKind.HEADING,
                            text=content,
                            heading_level=heading_level,
                            number_label=number_label,
                            source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                        )
                    )
```

`heading_counters` needs `nonlocal heading_counters` added to `_handle_paragraph`'s existing `nonlocal` line.

(`del heading_counters[heading_level:]` resets every deeper level back to empty whenever a shallower-or-equal heading appears — e.g. after `"2.1.1"` a new level-1 heading truncates the counters list to length 0 before incrementing index 0, correctly producing `"3"` not `"2.1.2"` or similar. The `while len(...) < heading_level: append(0)` handles a heading that jumps DEEPER than any counter seen so far, e.g. going straight from level 1 to level 3 with no level-2 in between.)

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_docx_loader.py tests/test_docx_pagination.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/loaders/docx_loader.py ingestion/tests/test_docx_loader.py
git commit -m "feat(docx_loader): synthesize dotted heading numbers into Block.number_label"
```

---

## Component 1: Cross-branch context (`ingestion/app/leveling/llm_leveling.py`)

### Task 10: Complete the outline (every heading, not just the first) + fix the heading-count undercount

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py:641-657` (`_build_document_outline` — moved from 639 to 641 by an unrelated earlier commit; loop body unchanged), `:1458` (`heading_count`), `:1691` (`branch_heading_count`) — all re-confirmed current as of 2026-08-13, see plan-level revision note
- Test: `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Produces: `_branch_heading_labels(blocks: list[Block]) -> list[str]`, module-level function. `_build_document_outline` (existing, unchanged signature) now calls it instead of `_derive_section_label`. Task 11's `_find_glossary_sections` calls it too.
- Consumes: `resolve_block_depth` (`app.leveling.depth`, already imported in this file).

`_build_document_outline` currently calls `_derive_section_label`, which returns only a branch's FIRST heading — merged branches (the common case for a real multi-section document) lose every heading after the first. It also checks `block.kind == BlockKind.HEADING` directly, missing numbered-paragraph pseudo-headings (`"3.2 Backplane Power"` as plain text) that `_split_into_branches` itself already treats as real heading boundaries via `resolve_block_depth` — an inconsistency between what drove the branch split and what the outline reports. The exact same `BlockKind.HEADING`-only undercount exists a second time, independently, in the `topic_count` quantitative-floor calculation (both the whole-document path at line 1458 and the per-branch path at line 1691).

(An unrelated, earlier commit added a table-group contribution — `topic_count=heading_count + len(doc_table_groups)` / `topic_count=branch_heading_count + len(branch_table_groups)` — downstream of these two lines. This task only touches the `heading_count = sum(...)` / `branch_heading_count = sum(...)` assignments themselves; the `+ len(...)` table-group addition is untouched and orthogonal. Test fixtures below use table-less documents, so `qualifying_table_groups(...)` always contributes 0 and the plain `heading_count`/`branch_heading_count` values are exactly what `topic_count` assertions check.)

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_llm_leveling.py`:

```python
def test_build_document_outline_lists_every_heading_in_a_merged_branch(monkeypatch) -> None:
    # Regression: _build_document_outline previously called
    # _derive_section_label, which returns only a branch's FIRST heading --
    # a branch merged from multiple original sections (the common case)
    # lost every heading after the first.
    _force_multi_branch(monkeypatch)
    path = "outline_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=2, text="Picture Modes", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="Three presets are supported.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert "Display" in fake.calls[0]["section_text"]
    assert "Picture Modes" in fake.calls[0]["section_text"]


def test_build_document_outline_lists_a_numbered_pseudo_heading(monkeypatch) -> None:
    # Regression: a plain-paragraph numbered heading ("3.2 Backplane
    # Power", no HEADING-kind block at all) was invisible to the outline
    # even though resolve_block_depth (what _split_into_branches itself
    # uses) already treats it as a real heading boundary.
    _force_multi_branch(monkeypatch)
    path = "numbered_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="2 Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert "1 Display" in fake.calls[0]["section_text"]
    assert "2 Audio" in fake.calls[1]["section_text"]


def test_topic_count_counts_numbered_pseudo_headings_on_the_whole_document_path() -> None:
    # Same undercount bug, second site: heading_count (line ~1458) used
    # BlockKind.HEADING directly, undercounting a numbered-paragraph spec's
    # real section count on the whole-document (fits-in-one-call) path.
    path = "numbered_whole_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="2 Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["whole_document"] is True
    assert fake.calls[0]["topic_count"] == 2


def test_topic_count_counts_numbered_pseudo_headings_on_the_multi_branch_path(monkeypatch) -> None:
    # Same undercount bug, per-branch site (line ~1691).
    _force_multi_branch(monkeypatch)
    path = "numbered_multi_branch.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Resolution", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["topic_count"] == 2  # "1 Display" AND "1.1 Resolution", not just 0


def test_build_document_outline_shows_a_synthesized_number_label_when_present(monkeypatch) -> None:
    # Component 2 (docx_loader Task 9) populates Block.number_label for a
    # heading with no number of its own -- the outline must render it
    # ("3.2 Backplane Power") so a cross-referencing branch can actually
    # use the number a human would recognize, not just the bare title.
    _force_multi_branch(monkeypatch)
    path = "labeled_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display",
                  number_label="1", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio",
                  number_label="2", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert "1 Display" in fake.calls[0]["section_text"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -k "outline_lists or topic_count_counts_numbered or synthesized_number_label" -v`
Expected: FAIL on every new test — the outline shows only each branch's first heading (missing "Picture Modes"), never shows a numbered-paragraph pseudo-heading at all, `topic_count` is `0` for both numbered-pseudo-heading tests, and the outline shows bare `"Display"` with no number prefix.

- [ ] **Step 3: Implement the fix**

Add this function right before `_build_document_outline` (line 639):

```python
def _branch_heading_labels(blocks: list[Block]) -> list[str]:
    """Every heading-equivalent block's text within a branch -- real
    HEADING-kind blocks AND numbered-paragraph pseudo-headings alike, via
    the SAME predicate _split_into_branches itself trusts
    (resolve_block_depth), not the narrower BlockKind.HEADING check
    _derive_section_label uses for its OWN (deliberately first-only)
    narration label. Prepends a docx-loader-synthesized number_label
    (see docx_loader.py's heading-number synthesis) when present, so a
    cross-referencing branch sees the same "3.2" a human reader would."""
    labels = []
    for block in blocks:
        if resolve_block_depth(block)[0] is None:
            continue
        labels.append(f"{block.number_label} {block.text}" if block.number_label else block.text)
    return labels
```

Change `_build_document_outline`'s loop body from:

```python
    for i, branch in enumerate(branches, start=1):
        label = _derive_section_label(branch, None, None) or f"(section {i})"
        lines.append(f"{i}. {label}")
```

to:

```python
    for i, branch in enumerate(branches, start=1):
        labels = _branch_heading_labels(branch)
        label = "; ".join(labels) if labels else f"(section {i})"
        lines.append(f"{i}. {label}")
```

At line 1458, change:

```python
    heading_count = sum(1 for b in doc.blocks if b.kind == BlockKind.HEADING)
```

to:

```python
    heading_count = sum(1 for b in doc.blocks if resolve_block_depth(b)[0] is not None)
```

At line 1691, change:

```python
            branch_heading_count = sum(1 for b in branch_blocks if b.kind == BlockKind.HEADING)
```

to:

```python
            branch_heading_count = sum(1 for b in branch_blocks if resolve_block_depth(b)[0] is not None)
```

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -v`
Expected: all PASS, including every pre-existing `topic_count`/outline test (e.g. `test_build_survey_tree_passes_the_real_heading_count_as_topic_count`, `test_build_survey_tree_chunks_a_multi_branch_document_into_one_call_per_branch`) — those fixtures use real `BlockKind.HEADING` blocks with no numbering-text conflict, so `resolve_block_depth` returns the same depth `BlockKind.HEADING` alone would have.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py
git commit -m "fix(llm_leveling): outline lists every heading (not just the first) and counts numbered pseudo-headings"
```

---

### Task 11: Inline short glossary/definitions sections into every OTHER branch's context

**Files:**
- Modify: `ingestion/app/leveling/llm_leveling.py:1469` (add `glossary_sections` init alongside `global_context`), `:1513` (after `_build_document_outline` call), `:1707` (the `_run_branch` closure's `global_context=` kwarg) — all three re-confirmed unchanged as of 2026-08-13 (the table-fidelity initiative's only `llm_leveling.py` touch was `_table_to_markdown`/figure-id plumbing, nowhere near this task's targets), see plan-level revision note
- Test: `ingestion/tests/test_llm_leveling.py`

**Interfaces:**
- Consumes: `_branch_heading_labels` (Task 10), `render_section` (existing), `_estimate_tokens` (existing), `_partition_tables_by_branch` (existing, already imported from `tree_builder`).
- Produces: `_find_glossary_sections(branches, branch_tables) -> list[tuple[int, str, str]]` (branch index, section label, rendered text), `_glossary_context_for_branch(branch_index, glossary_sections) -> str | None`, `_combine_global_context(base, branch_index, glossary_sections) -> str | None` — all module-level, placed right after `_branch_heading_labels`/`_build_document_outline`.

A short definitions/acronyms/glossary section is exactly the content a DIFFERENT branch is most likely to need and least likely to have — confirmed live as a real failure mode (`_detect_conflicting_duplicates`'s own docstring: 9 duplicate description pairs across sections in one real job, including a genuine spec conflict). Inline such a branch's FULL rendered content (not just its outline label) into every OTHER branch's `global_context`, deterministically (no new LLM call), reaching every model regardless of tool-calling support (`global_context` is prepended to every branch's `section_text` unconditionally, per line 1951-1952, not gated on `supports_tools`). Oversized matches are left outline-label-only — never partially inlined. A branch never gets its OWN content re-inlined into its own context (it's already there, in full, as `section_text` — duplicating it in the SAME prompt risks the model emitting duplicate nodes for the same content within one call).

- [ ] **Step 1: Write the failing tests**

```python
def _doc_with_glossary_branch(path: str = "glossary_doc.txt") -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Definitions and Acronyms",
                  source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="HDR: High Dynamic Range.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )


def test_a_small_glossary_branch_is_inlined_into_a_different_branchs_context(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_doc_with_glossary_branch(), fake)
    assert len(fake.calls) == 2
    # The Display branch's OWN call receives the glossary branch's content.
    display_call = next(c for c in fake.calls if "The display shall support HDR." in c["section_text"])
    assert "HDR: High Dynamic Range." in display_call["section_text"]


def test_a_branch_does_not_get_its_own_content_re_inlined(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_doc_with_glossary_branch(), fake)
    glossary_call = next(c for c in fake.calls if "Definitions and Acronyms" in c["section_text"])
    # "HDR: High Dynamic Range." appears once (in section_text itself, as
    # the glossary branch's OWN content) -- not a second time via a
    # self-referential inlined copy.
    assert glossary_call["section_text"].count("HDR: High Dynamic Range.") == 1


def test_an_oversized_glossary_branch_is_not_inlined(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    path = "oversized_glossary.txt"
    huge_definition = "Term: " + ("word " * 2000)  # well over the inline token cap
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Glossary", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text=huge_definition, source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    display_call = next(c for c in fake.calls if "The display shall support HDR." in c["section_text"])
    assert huge_definition not in display_call["section_text"]
    assert "Glossary" in display_call["section_text"]  # still shows up as an outline label


def test_a_branch_with_no_glossary_heading_match_gets_no_extra_context(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_two_branch_doc(), fake)  # "Display"/"Audio" -- no glossary-keyword heading
    assert len(fake.calls) == 2
    for call in fake.calls:
        assert "Reference section" not in call["section_text"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -k "glossary" -v`
Expected: FAIL on the inlining tests (`"HDR: High Dynamic Range."` is not present in the Display branch's `section_text` today); the "no glossary heading match" test currently PASSES already (nothing to regress there, but it's included as a guard against over-matching once the feature lands).

- [ ] **Step 3: Implement the fix**

Add these functions right after `_branch_heading_labels`/`_build_document_outline` (both from Task 10):

```python
_GLOSSARY_HEADING_PATTERN = re.compile(r"(?i)\b(definition|acronym|glossary|abbreviation|terminolog)")
_GLOSSARY_INLINE_MAX_TOKENS = 500


def _find_glossary_sections(
    branches: list[list[Block]], branch_tables: list[list[Table]]
) -> list[tuple[int, str, str]]:
    """(branch_index, section_label, rendered_text) for every branch whose
    heading matches a definitions/acronyms/glossary/abbreviations/
    terminology keyword AND whose full rendered content fits under
    _GLOSSARY_INLINE_MAX_TOKENS. An oversized match is excluded entirely
    (never partially inlined -- an unpredictable truncation appearing
    mid-glossary would be worse than the label-only status quo)."""
    matches = []
    for i, (branch, tables) in enumerate(zip(branches, branch_tables)):
        labels = _branch_heading_labels(branch)
        if not any(_GLOSSARY_HEADING_PATTERN.search(label) for label in labels):
            continue
        rendered = render_section(branch, tables)
        if not rendered or _estimate_tokens(rendered) > _GLOSSARY_INLINE_MAX_TOKENS:
            continue
        section_label = labels[0] if labels else "(untitled section)"
        matches.append((i, section_label, rendered))
    return matches


def _glossary_context_for_branch(
    branch_index: int, glossary_sections: list[tuple[int, str, str]]
) -> str | None:
    """Every glossary_sections entry EXCEPT the branch's own (a branch
    already sees its own content in full as section_text -- re-inlining
    it into the SAME call's global_context would duplicate it within one
    prompt, risking a duplicate-node result for that one call)."""
    others = [(label, rendered) for i, label, rendered in glossary_sections if i != branch_index]
    if not others:
        return None
    parts = [f'Reference section "{label}":\n{rendered}' for label, rendered in others]
    return (
        "The following short reference section(s) from elsewhere in this "
        "document are inlined in full because every section may need them "
        "(definitions/acronyms/units):\n\n" + "\n\n".join(parts)
    )


def _combine_global_context(
    base: str | None, branch_index: int, glossary_sections: list[tuple[int, str, str]]
) -> str | None:
    extra = _glossary_context_for_branch(branch_index, glossary_sections)
    if extra is None:
        return base
    return f"{base}\n\n{extra}" if base else extra
```

At line 1469 (where `global_context: str | None = None` is declared, right before the `if fits_whole_document:`/`else:`), add:

```python
    glossary_sections: list[tuple[int, str, str]] = []
```

Right after the existing `global_context = _build_document_outline(branches)` call (line 1513, inside the `else:` branch), add:

```python
        glossary_branch_tables = _partition_tables_by_branch(branches, doc.tables) if branches else []
        glossary_sections = _find_glossary_sections(branches, glossary_branch_tables)
```

In `_run_branch` (line 1707), change:

```python
                global_context=global_context, read_other_section_fn=read_other_section_fn,
```

to:

```python
                global_context=_combine_global_context(global_context, branch_index, glossary_sections),
                read_other_section_fn=read_other_section_fn,
```

- [ ] **Step 4: Run tests to verify they pass, and the full existing suite still passes**

Run: `cd ingestion && .venv/bin/python -m pytest tests/test_llm_leveling.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ingestion/app/leveling/llm_leveling.py ingestion/tests/test_llm_leveling.py
git commit -m "feat(llm_leveling): inline small glossary/definitions branches into every other branch's context"
```

---

## Self-Review Notes

**Spec coverage:** every design-doc item maps to a task —
outline completeness → Task 10; glossary inlining → Task 11; heading
detection (outlineLvl/style/Title/crash-guard) → Task 2; `w:sdt` → Task 1;
list items → Task 3; icon filtering → Task 6; number synthesis → Task 9;
caption linking → Task 4; altChunk/OLE/nested-table/text-box fail-loud
markers → Tasks 5/6/7/8.

**Placeholder scan:** no TBD/TODO; every step has real code, not a
description of code.

**Type consistency:** `_heading_level_for_paragraph` (Task 2) returns
`int | None`, consumed identically in Tasks 2/4/9. `_branch_heading_labels`
(Task 10) returns `list[str]`, consumed by `_build_document_outline`
(Task 10) and `_find_glossary_sections` (Task 11) with the same shape.
`glossary_sections: list[tuple[int, str, str]]` is the same shape
everywhere it's threaded (init at 1469, populated at 1513, consumed at
1707, and in every helper's signature).

**Sequencing dependency confirmed real, not assumed:** Task 10's
`_branch_heading_labels` reads `block.number_label`, which only Task 9
(Component 2) ever populates — but the field already exists on `Block`
(unused, per `app/canonical/model.py:96`) and defaults to `None`, so
Task 10 is independently correct (and independently testable, per its
own explicit `number_label="1"` test fixture) even if run before Task 9;
Task 9 landing later simply makes the `number_label` branch start firing
for real docx input without any further code change.

**Re-verification pass (2026-08-13):** the repo moved substantially between
this plan's original authoring (2026-08-11, against a 188-line
`docx_loader.py`) and now (761 lines, after the table-fidelity initiative's
schema migration from `Table.rows: list[list[str]]` to `Table.cells:
list[list[TableCell | None]]`). Every task was re-checked against the
CURRENT file content, not assumed stale-but-close: Tasks 2, 3, 4, 5, 6, 8, 9
confirmed byte-for-byte still targeting live, unmodified code (heading
detection, the fallback image-rel sweep, `w:altChunk`/`w:object`/
`w:txbxContent` all still entirely absent from the loader). Task 10 needed
only a cosmetic line-number correction (639→641; an unrelated earlier
commit shifted it, content unchanged). Task 11's three edit sites (1469,
1513, 1707) are untouched by the table-fidelity work and confirmed exact.
Tasks 1 and 7 required real rewrites: Task 1's `_handle_table` closure body
now calls the CURRENT `_extract_table_cells`/`_column_widths`/
`_table_border_style` construction instead of the old `rows=` one-liner;
Task 7 now appends its marker into `TableCell.text` inside
`_extract_table_cells` itself (not `_handle_table`, and not a raw string
replacement) via `cell.tables` — the schema and the actual grid-building
function both changed since the original write-up, and this rewrite was
grounded by reading the CURRENT `_extract_table_cells` implementation in
full (lines 477-583), not inferred from the old design.
