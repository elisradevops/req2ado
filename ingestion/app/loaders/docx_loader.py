from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Callable, Literal

from docx import Document as DocxDocument
from docx.oxml.ns import qn
from docx.oxml.table import CT_Row, CT_Tc
from docx.table import Table as DocxTable
from docx.table import _Cell as DocxCell
from docx.text.paragraph import Paragraph as DocxParagraph

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table, TableCell

logger = logging.getLogger(__name__)

_STYLE_HEADING_PREFIX = "Heading "
_IMAGE_RELTYPE_MARKER = "image"

# w:jc/@w:val -> TableCell.align. Deliberately a plain dict, not python-docx's
# own WD_PARAGRAPH_ALIGNMENT.from_xml(): that enum has NO member at all for
# the modern `start`/`end` spellings (only the legacy left/right/center/both
# tokens), so calling it on a real `start`/`end` value raises ValueError --
# a real, if uncommon, value this loader must not choke on. `both` is
# OOXML's own name for full justification. `start`/`end` are mapped to the
# LTR reading (left/right) -- this codebase has no RTL-direction signal to
# do better than that today; if a bidi/RTL table is ever reported as
# misrendering, this mapping is the first place to revisit, not a silent
# correctness bug in the meantime.
_JC_TO_ALIGN: dict[str, Literal["left", "center", "right", "justify"]] = {
    "left": "left",
    "center": "center",
    "right": "right",
    "both": "justify",
    "start": "left",
    "end": "right",
}


def _row_is_header(tr: CT_Row) -> bool:
    """`w:trPr/w:tblHeader` presence (any value, or none at all -- OOXML
    treats bare presence of the element as true, same convention as
    `w:vMerge` with no `@w:val`). Documented meaning is "this row repeats
    as a header on every printed page", which is also the closest real,
    explicit signal Word itself gives for "this is a header row" -- there
    is no separate/better one. python-docx's `CT_TrPr` doesn't expose this
    as a property (only `gridBefore`/`gridAfter`/`trHeight` are declared
    fields on it), so it's read directly off the raw element via `qn()`,
    the same fallback-to-raw-OOXML convention `grid_span`/`vMerge` already
    established in this module before this rewrite.
    """
    trPr = tr.trPr
    if trPr is None:
        return False
    return trPr.find(qn("w:tblHeader")) is not None


def _cell_alignment(tc: CT_Tc) -> Literal["left", "center", "right", "justify"] | None:
    """First paragraph's `w:pPr/w:jc/@w:val`, read as a raw XML string
    (see `_JC_TO_ALIGN` above for why -- python-docx's own alignment
    properties raise on modern `start`/`end` values). A cell can hold
    multiple paragraphs with different alignment each; `TableCell` has no
    per-paragraph shape, so the FIRST paragraph's alignment is used as the
    cell's alignment -- the simplest reasonable rule for a v1 model, not a
    claim that every paragraph agrees. An unrecognized/exotic `w:val`
    (`distribute`, `mediumKashida`, ...) intentionally falls through to
    `None` via `dict.get` rather than guessing.
    """
    if not tc.p_lst:
        return None
    pPr = tc.p_lst[0].find(qn("w:pPr"))
    if pPr is None:
        return None
    jc = pPr.find(qn("w:jc"))
    if jc is None:
        return None
    return _JC_TO_ALIGN.get(jc.get(qn("w:val")))


def _cell_is_bold(cell: DocxCell) -> bool:
    """Uniform-bold rule (see `TableCell.bold`'s own docstring in
    `app/canonical/model.py` for the full rationale): a cell is bold only
    if EVERY run containing non-whitespace text, across every paragraph in
    the cell, is bold. Rejects a "first non-empty run is bold" rule, which
    mis-fires badly on a bold label prefix ("*Note:* rest of sentence") --
    that would bold the entire cell for what should read as a bold PREFIX
    only. Whitespace-only/empty runs are skipped entirely rather than
    counted against the cell, so a bold cell with trailing whitespace in a
    plain run still reads as bold. `run.bold` is python-docx's own
    tri-state read of `w:rPr/w:b` -- True, False, or None when inherited
    from the style hierarchy; None is treated the same as False here (not
    EXPLICITLY bold), a conservative approximation consistent with this
    loader not resolving style inheritance anywhere else either (see the
    table-style shading finding in the design spec's Phase 0 section). A
    cell with no non-whitespace runs at all (blank cell) is not bold.
    """
    saw_non_whitespace_run = False
    for paragraph in cell.paragraphs:
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            saw_non_whitespace_run = True
            if not run.bold:
                return False
    return saw_non_whitespace_run


def _extract_table_cells(docx_table: DocxTable) -> list[list[TableCell | None]]:
    """Builds the canonical `cells: list[list[TableCell | None]]` grid for
    a table (`app/canonical/model.py`'s `Table.cells`), expanding merged
    cells structurally instead of naively reading `row.cells` (the
    previous approach, and the reason this function originally existed --
    see git history for the "FAN configuration - 1" x3 / "GPU" x2
    duplication bug this replaced). `row.cells` has DOCUMENTED behavior in
    python-docx: for a cell with a horizontal merge (`w:tcPr/w:gridSpan`)
    or a vertical merge (`w:tcPr/w:vMerge`), it returns text resolved from
    the SAME origin `_Cell` at every grid position the merge spans -- so a
    naive per-position `.text` read duplicates the merged cell's real
    content. Relying on `.text` equality or `_Cell` object identity to
    detect this is unreliable (fresh wrapper objects are created per
    `row.cells` call, so `id()` can coincidentally collide after GC reuse)
    -- so merge state is instead read from the real OOXML via each
    physical `w:tc` element's `grid_span` / `vMerge` properties (there is
    no other public API for this in python-docx).

    Grid semantics, one real `TableCell` per ORIGIN position, `None`
    everywhere else a merge (or an omitted `gridBefore`/`gridAfter`
    position) covers:
      - `w:tcPr/w:gridSpan/@w:val` (`tc.grid_span`, defaults to 1 when
        absent) is carried straight through to `TableCell.colspan` --
        the remaining `grid_span - 1` grid positions to its right are
        left `None` (pre-filled below), never given their own `TableCell`.
      - `w:tcPr/w:vMerge` (`tc.vMerge`): `None` when absent (not merged),
        `"restart"` for the origin row of a vertical span, `"continue"`
        for every subsequent row -- including when `w:vMerge` is present
        with NO `@w:val` attribute at all, which OOXML (and python-docx's
        own `ST_Merge` default) treats as an implicit "continue". A
        `"continue"` `w:tc` is a pure continuation regardless of what
        text, if any, its own paragraph carries: it is skipped entirely
        here (never given a `TableCell`), leaving its grid position(s) at
        the pre-filled `None` -- exactly the model's "spanned" meaning.
        Its real rowspan count was already computed once, on the ORIGIN
        cell, so nothing is lost by ignoring the continuation cells' own
        content.
      - Real rowspan count: `tc.bottom - tc.top`. python-docx's own
        `CT_Tc.top`/`.bottom` already do the cross-row walk (following
        `vMerge == "continue"` down/up via `_tc_below`/`_tc_above`) AND
        already resolve each row's real grid column through
        `tc.grid_offset` / `CT_Row.tc_at_grid_offset`, which itself
        accounts for `w:trPr/w:gridBefore` (unpopulated columns at the
        START of a row) -- exactly the column-index bookkeeping this
        function would otherwise have to hand-roll to avoid landing a
        rowspan in the wrong column on a document using `gridBefore`/
        `gridAfter`. Reusing these properties instead of re-deriving grid
        columns from scratch is why no separate "current column" counter
        is threaded through this function's own loop. For a non-merged
        cell (`vMerge is None`), `.top`/`.bottom` still resolve correctly
        (`_tr_idx` and `_tr_idx + 1`), so `tc.bottom - tc.top` is always 1
        in that case -- no separate branch is needed for the common case.
      - `w:tcPr` positions never touched by any `w:tc` in the row at all
        (a `gridBefore`/`gridAfter` omission, not a merge) are also left
        `None`. Unlike a heuristically-detected PDF table, every docx grid
        position with real content has an explicit `w:tc` element -- OOXML
        simply has no notion of "detected an empty region with no
        backing element" the way pdfplumber's geometry-only extraction
        does, so a genuine `TableCell(text="")` GAP (as opposed to a
        `None` SPANNED position) is not something a docx table can
        produce; this was confirmed by reading the OOXML table model
        rather than assumed.
      - `w:trPr/w:tblHeader` presence marks every cell in that row
        `is_header=True` (see `_row_is_header`).
      - Alignment (`_cell_alignment`) and the uniform-bold rule
        (`_cell_is_bold`) are both per-origin-cell only, for the same
        reason spans are -- a `"continue"`/spanned position never gets its
        own `TableCell` to hold them.

    `background_color`/`text_color`/`column_widths`/`border_style` are
    deliberately left at their model defaults (`None`) here -- explicit
    per-cell shading/border/width extraction is Phase 2 of
    docs/superpowers/specs/2026-08-12-table-fidelity-design.md, and Phase
    0 of that spec found most real Word table shading comes from
    `w:tblStyle`-inherited conditional formatting that python-docx doesn't
    resolve at all, not per-cell `w:shd` -- extracting only the per-cell
    case would be misleadingly incomplete, so it isn't attempted here.
    """
    n_cols = len(docx_table.columns)
    grid: list[list[TableCell | None]] = []
    for row in docx_table.rows:
        tr = row._tr
        row_cells: list[TableCell | None] = [None] * n_cols
        is_header = _row_is_header(tr)
        for tc in tr.tc_lst:
            if tc.vMerge == "continue":
                continue
            cell = DocxCell(tc, docx_table)
            row_cells[tc.grid_offset] = TableCell(
                text=cell.text.strip(),
                colspan=tc.grid_span,
                rowspan=tc.bottom - tc.top,
                is_header=is_header,
                bold=_cell_is_bold(cell),
                align=_cell_alignment(tc),
            )
        grid.append(row_cells)
    return grid


def _describe_one_figure(
    rel, describe_figure: Callable[[bytes], str] | None
) -> str | None:
    """Shared per-image describe_figure call + failure handling, used by
    both the inline (real document-order) and fallback (floating/unmatched
    rel) figure paths below -- a vision failure for one image must not
    abort the whole document, same guarantee either path relies on."""
    if describe_figure is None:
        return None
    try:
        return describe_figure(rel.target_part.blob)
    except Exception:  # noqa: BLE001 -- a vision failure must not abort the whole document
        logger.warning(
            "describe_figure failed for %s (rel target %s)", rel.target_part.content_type, rel.target_ref, exc_info=True
        )
        return None


def load_docx(path: str, describe_figure: Callable[[bytes], str] | None = None) -> CanonicalDoc:
    """`describe_figure`, when provided, is called with each embedded
    image's raw bytes and must return a short text description -- used to
    replace the `[FIGURE: none]` placeholder with real content (see
    app/vision/orchestrator_vision_client.py). None (the default) preserves
    the original placeholder-only behavior exactly. A describe_figure
    failure for one image must not abort the whole document -- caught and
    falls back to the placeholder for that image only."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.DOCX, sha256=sha256)

    docx_doc = DocxDocument(path)
    blocks: list[Block] = []
    tables: list[Table] = []
    figures: list[Figure] = []
    block_id = 0
    table_index = 0
    figure_index = 0
    offset = 0
    # Every image rel consumed inline (see the w:p branch below) is recorded
    # here so the fallback pass after the body walk doesn't double-emit it.
    consumed_rel_ids: set[str] = set()

    # Single body-element walk (python-docx's standard idiom for document
    # order) instead of the previous two SEPARATE extraction passes
    # (docx_doc.paragraphs, then docx_doc.tables) -- that lost any real
    # ordering relationship between the two: a table's SourceRef was always
    # the (0,0) placeholder, and render_section could only ever append ALL
    # of a branch's tables at its very end, never interleaved at their real
    # position. Sharing one monotonically increasing `offset` counter across
    # blocks, tables, AND inline figures (see below) gives every element a
    # real, comparable order position.
    for child in docx_doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            paragraph = DocxParagraph(child, docx_doc)
            content = paragraph.text.strip()
            # Inline drawings (a pasted image, or a converted EMF/WMF
            # diagram) embedded directly in this paragraph -- resolved via
            # the DrawingML <a:blip r:embed="..."> reference to the actual
            # image part. Previously EVERY image rel on the whole document
            # was collected in one pass AFTER this body walk finished, each
            # given a (0, 0) placeholder SourceRef -- so every figure folded
            # into whichever node happened to be open LAST, not its real
            # parent (see tree_builder.py's depth=None fold). Resolving
            # inline, at the paragraph's own position, gives each figure the
            # same real-position treatment tables already got.
            blip_elements = child.findall(f".//{qn('a:blip')}")
            embed_ids = [embed_id for b in blip_elements if (embed_id := b.get(qn("r:embed")))]

            if not content and not embed_ids:
                continue

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
        elif child.tag == qn("w:tbl"):
            docx_table = DocxTable(child, docx_doc)
            cells = _extract_table_cells(docx_table)
            start = offset
            end = start + 1
            offset = end
            # Real per-cell colspan/rowspan/is_header/align/bold -- see
            # _extract_table_cells' own docstring. background_color/
            # text_color/column_widths/border_style stay at their model
            # defaults (None): explicit style extraction is Phase 2 of
            # docs/superpowers/specs/2026-08-12-table-fidelity-design.md,
            # not this pass.
            tables.append(
                Table(
                    id=f"t{table_index}",
                    cells=cells,
                    source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
                )
            )
            table_index += 1

    # Fallback: any image rel NOT consumed above (a floating/anchored
    # drawing rather than an inline one, a header/footer image, or any
    # other embedding this walk doesn't recognize) keeps the previous
    # append-at-end, (0, 0)-placeholder behavior -- a documented
    # approximation for the cases this walk can't place, not silent loss.
    for rel_id, rel in docx_doc.part.rels.items():
        if rel_id in consumed_rel_ids or _IMAGE_RELTYPE_MARKER not in rel.reltype:
            continue
        caption = _describe_one_figure(rel, describe_figure)
        figures.append(
            Figure(
                id=f"f{figure_index}",
                caption=caption,
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )
        blocks.append(
            Block(
                id=f"b{block_id}",
                kind=BlockKind.FIGURE,
                text=f"[FIGURE: {caption or 'none'}]",
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )
        block_id += 1
        figure_index += 1

    return CanonicalDoc(document=document, blocks=blocks, tables=tables, figures=figures)
