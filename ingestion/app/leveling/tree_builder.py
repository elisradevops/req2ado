from __future__ import annotations

import hashlib
import html
import re
from pathlib import Path

from app.canonical.model import Block, BlockKind, CanonicalDoc, Figure, SourceRef, Table, TableCell
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.autodetect import classify_numbering_branch, is_heading_style_branch
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import heading_style_type_for_depth
from app.leveling.table_color import colgroup_html, resolve_cell_style_colors, table_style_attr
from app.leveling.warnings_finalize import finalize_warnings
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


def _split_into_branches(doc: CanonicalDoc) -> list[list[Block]]:
    resolved = [(block, resolve_block_depth(block)[0]) for block in doc.blocks]
    known_depths = [depth for _, depth in resolved if depth is not None]
    # The document's own shallowest heading/numbering level is the real
    # top-level boundary -- previously hardcoded to depth==1, which silently
    # produced ONE giant unsplit branch for any document whose shallowest
    # heading isn't Heading 1 (common when a template's Heading 1 is
    # reserved for the document title only, and body sections start at
    # Heading 2). Observed live: an 800-paragraph ICD with headings starting
    # at Heading 2 collapsed into a single 500+-node branch in SURVEY mode,
    # blowing every per-branch LLM-call timeout. Falls back to 1 for a
    # headingless document (build_baseline_tree's caller already
    # short-circuits to _build_headingless_tree before this function is
    # ever reached in that case, so this fallback is defensive, not load-bearing).
    top_level_depth = min(known_depths) if known_depths else 1
    branches: list[list[Block]] = []
    current: list[Block] = []
    for block, depth in resolved:
        if depth == top_level_depth and current:
            branches.append(current)
            current = []
        current.append(block)
    if current:
        branches.append(current)
    return branches


def _bound_branch_size(branch: list[Block], max_block_count: int) -> list[list[Block]]:
    """Recursively re-splits a single branch that is still oversized after
    _split_into_branches, at that branch's OWN next-shallowest depth level
    -- SURVEY-only (see llm_leveling.build_survey_tree's caller): a
    real-world document can have very few top-level sections that are
    wildly unbalanced in size (observed live: an ICD with only 4 top-level
    sections, one of them 372 blocks -- still large enough to blow a
    per-branch LLM-call timeout even after the top-level depth-detection
    fix). Splitting on the document's actual heading structure alone cannot
    guarantee every branch stays small; this guarantees it regardless of
    that structure, by bounding branch size directly.

    Deliberately NOT applied to build_baseline_tree's branches:
    is_heading_style_branch/classify_numbering_branch reason over a
    branch's own tree shape, and sub-splitting would change what a sub-chunk
    classifies as compared to the original, whole section -- a real
    behavior change BASELINE mode has no need for (it doesn't call an LLM,
    so branch size was never a timeout risk there in the first place).

    Falls back to leaving a branch unsplit (returned as-is) when it has no
    further internal structure to split on -- a big flat run of body text
    with no sub-headings genuinely cannot be chunked smaller without an
    arbitrary block-count cut that would sever a requirement's sentence
    from its own continuation blocks.

    After splitting at the document's own next-shallowest depth, adjacent
    resulting pieces are greedily re-merged (in original document order)
    back up toward max_block_count -- splitting on structure alone can
    fragment a document with many small sections (a real ICD's fine-grained
    numbering) into far more, far smaller pieces than max_block_count
    actually requires, each costing its own full LLM round trip. Merging
    keeps every final branch's own document-order contiguity while cutting
    the branch (and therefore LLM call) count roughly in proportion to how
    small the natural sections are relative to the cap.
    """
    if len(branch) <= max_block_count:
        return [branch]
    resolved = [(block, resolve_block_depth(block)[0]) for block in branch]
    known_depths = [depth for _, depth in resolved if depth is not None]
    if not known_depths:
        return [branch]
    boundary_depth = min(known_depths)
    finer_depths = [depth for depth in known_depths if depth > boundary_depth]
    if not finer_depths:
        return [branch]
    split_depth = min(finer_depths)
    sub_branches: list[list[Block]] = []
    current: list[Block] = []
    for block, depth in resolved:
        if depth == split_depth and current:
            sub_branches.append(current)
            current = []
        current.append(block)
    if current:
        sub_branches.append(current)
    if len(sub_branches) <= 1:
        # split_depth didn't actually produce a new boundary -- avoid an
        # infinite recursion loop and just accept this branch's size.
        return [branch]
    expanded: list[list[Block]] = []
    for sub_branch in sub_branches:
        expanded.extend(_bound_branch_size(sub_branch, max_block_count))
    result: list[list[Block]] = []
    merged: list[Block] = []
    for piece in expanded:
        if merged and len(merged) + len(piece) > max_block_count:
            result.append(merged)
            merged = []
        merged.extend(piece)
    if merged:
        result.append(merged)
    return result


def _hash_description(description: str) -> str:
    return hashlib.sha256(description.encode()).hexdigest()


def _hash_identity(description: str, source_ref: SourceRef) -> str:
    """See WorkItemNode.identity_hash's own docstring for why this is a
    SEPARATE hash from fidelity_hash. `source_ref` here is always the node's
    OWN, never-changing source position (the block/table that originally
    created it) -- not the position of whatever most recently folded into
    it -- distinguishing two nodes whose description happens to become
    byte-identical (see test_two_byte_identical_requirement_lines_get_distinct_identity_hashes).

    `description` is deliberately NOT hashed (confirmed real bug, live: two
    uploads of the byte-identical BASELINE document never matched via this
    hash, even though document_path/start_offset/end_offset are already
    fully determined by the point this function is called and description
    itself is verbatim/deterministic in every one of this file's call
    sites -- the extra input bought nothing and, in the one genuinely
    LLM-generated call site elsewhere (llm_leveling.py's branch-analysis
    node creation), made the hash actively unstable run-to-run). Position
    alone is both necessary and sufficient here: every call site in this
    module gives each node its own distinct source_ref already."""
    return hashlib.sha256(
        f"{source_ref.document_path}\x00{source_ref.start_offset}\x00{source_ref.end_offset}".encode()
    ).hexdigest()


def _hash_identity_for_synthesized_node(discriminator: str, source_ref: SourceRef) -> str:
    """Variant for auto-inserted structural nodes (root_regrouping.py's
    synthesized group/root-epic/feature nodes) that deliberately REUSE one
    of their own member's source_ref rather than owning a distinct source
    span of their own -- e.g. a synthesized group node and its own first
    child currently share source_ref. Without a discriminator, plain
    _hash_identity (position-only) would collide the two. `discriminator`
    must be a stable, deterministic string (root_regrouping.py's synth_id,
    e.g. "synth_group_3" -- never LLM-generated free text, which would
    reintroduce the exact instability _hash_identity's own docstring
    explains dropping)."""
    return hashlib.sha256(
        f"{discriminator}\x00{source_ref.document_path}\x00{source_ref.start_offset}\x00{source_ref.end_offset}".encode()
    ).hexdigest()


def _widen_page_end(open_ref: SourceRef, folded_ref: SourceRef) -> SourceRef:
    """Widens an already-open node's own page_end to also cover a block/
    table that just folded into its Description -- so a node's page range
    reflects the FULL span of everything folded into it (see
    docx_pagination.py, which is what actually populates real page/page_end
    on a docx's blocks/tables/figures; pdf/pptx loaders already set `page`
    directly). A no-op when the open node itself has no page at all (True
    for every docx document before alignment ever runs, or when it failed)
    -- SourceRef's own docstring insists page_end is never set without page
    also being set, so this must never widen page_end on a page-less ref.

    Folds always proceed in document order, so the folded content's own
    page is never EARLIER than the open node's own -- max() here can only
    ever hold or grow page_end, never lower it (asserted directly in this
    module's and llm_leveling.py's own fold tests)."""
    if open_ref.page is None:
        return open_ref
    existing_end = open_ref.page_end if open_ref.page_end is not None else open_ref.page
    incoming_end = folded_ref.page_end if folded_ref.page_end is not None else folded_ref.page
    if incoming_end is None:
        return open_ref
    widened = max(existing_end, incoming_end)
    if widened == open_ref.page_end:
        return open_ref
    return open_ref.model_copy(update={"page_end": widened})


def _derive_doc_title(doc: CanonicalDoc) -> str:
    """Filename-derived title for a document with no heading structure at
    all — there is no heading/numbered-line text to extract a title from,
    so this is the one BASELINE code path where a title is not a verbatim
    source-span extraction. See _build_headingless_tree."""
    stem = Path(doc.document.path).stem.replace("_", " ").replace("-", " ").strip()
    return extract_baseline_title(stem or "Untitled Document")


_FIGURE_TEXT_PATTERN = re.compile(r"^\[FIGURE:\s*(.*?)\s*\]$")


def _figure_line(block: Block) -> str | None:
    """FIGURE-kind blocks carry their caption embedded in block.text as
    "[FIGURE: {caption or 'none'}]" (see docx_loader.py/pdf_loader.py) --
    parse it back out. A 'none' placeholder (no real caption -- vision
    disabled, or the vision call failed for this image) is omitted from the
    rendered section entirely: the literal placeholder string must never
    reach the model and be mistaken for real content (the root cause of the
    "[FIGURE: none]" fake-requirement bug this redesign fixes). A real
    caption is rendered as a clearly-labeled blockquote line. Shared by both
    BASELINE (this module) and SURVEY (llm_leveling.py, imported from here)
    folding paths so a placeholder-only figure never leaks into a work item
    description in either mode."""
    match = _FIGURE_TEXT_PATTERN.match(block.text)
    caption = match.group(1) if match else block.text
    if not caption or caption.lower() == "none":
        return None
    return f"> Figure: {caption}"


_UNSUPPORTED_NOTE_PREFIX = "[UNSUPPORTED:"


def _is_unsupported_content_note(block: Block) -> bool:
    """True for a NOTE-kind block whose text is a loader-emitted diagnostic
    placeholder (e.g. pdf_loader.py's multi-column-layout heuristic firing on
    a cover page) -- never real document content, and must never reach the
    model/output and be mistaken for a genuine note, the same class of bug
    _figure_line's "[FIGURE: none]" handling above fixes for figures. Filters
    by TEXT PREFIX, not `BlockKind.NOTE` alone: pptx_loader.py legitimately
    uses NOTE for real speaker-notes content -- a kind-only filter would
    delete real reviewer content. Shared by both BASELINE (this module) and
    SURVEY (llm_leveling.py, imported from here) so the diagnostic never
    leaks into a work item's section label, description, or rendered section
    text in either mode."""
    return block.kind == BlockKind.NOTE and block.text.startswith(_UNSUPPORTED_NOTE_PREFIX)


def figure_id_by_block_id(doc: CanonicalDoc) -> dict[str, str]:
    """block.id -> Figure.id map, built once over a document (or residual
    document) by pairing every FIGURE-kind Block in `doc.blocks` with
    `doc.figures` in loader-append order -- every loader (docx/pptx/pdf)
    appends a Figure and its paired inline FIGURE-kind Block in lockstep
    (confirmed via each loader's own source), so the i-th FIGURE-kind block
    really is doc.figures[i] for the SAME i, without needing a
    source_ref-based lookup (source_ref alone is ambiguous for docx's own
    floating-image fallback path, which can give several figures the
    identical (0, 0) placeholder ref).

    Shared here so every node-building path that needs to attribute a
    figure's real id to a work item (see WorkItemNode.figure_ids/
    uncaptioned_figure_ids' own docstrings) reuses the identical pairing
    logic instead of duplicating it -- originally inlined once in
    llm_leveling.py's SURVEY path alone (known-issues item 20); hoisted
    here so BASELINE (this module) and the deterministic heading/table-row
    path can build the same map over their own `doc`/`llm_doc` without a
    copy of this zip."""
    return dict(
        zip(
            (b.id for b in doc.blocks if b.kind == BlockKind.FIGURE),
            (f.id for f in doc.figures),
        )
    )


def figures_by_id(figures: list[Figure]) -> dict[str, Figure]:
    """Figure.id -> Figure map -- built once per call site (mirrors
    figure_id_by_block_id's own "build once, reuse" convention) wherever a
    caller already has a figure_id (via figure_id_by_block_id above, or a
    branch's own `figures` list) and needs to look up that Figure's
    caption_status to decide whether an uncaptioned figure is also
    insignificant (see WorkItemNode.insignificant_figure_ids)."""
    return {f.id: f for f in figures}


def _row_is_header(row: list[TableCell | None]) -> bool:
    """A row counts as a header row only if it has at least one real
    (non-None) cell AND every real cell in it is is_header=True. The signal
    is inherently row-level on every format that sets it today (docx's
    w:trPr/w:tblHeader, xlsx's freeze_panes heuristic) -- there is no
    "partially header" row in v1, so a row with a mix of header/non-header
    real cells renders entirely as <td> (see _table_to_html's per-row
    dispatch below), not a per-cell split."""
    real_cells = [cell for cell in row if cell is not None]
    return bool(real_cells) and all(cell.is_header for cell in real_cells)


def _render_table_row(row: list[TableCell | None], cell_tag: str, border_style: str | None) -> str:
    """Renders one grid row as a single-line <tr>...</tr>. A None position
    is a SPANNED cell (absorbed by a preceding cell's colspan/rowspan) and
    contributes NO output at all -- emitting an empty <td> there would add
    an extra cell beyond the row's real column count and corrupt the whole
    table's alignment (confirmed live against pdfplumber's own span/gap
    output, see docs/superpowers/specs/2026-08-12-table-fidelity-design.md's
    Phase 0 findings). A real TableCell with text="" (a genuine gap) DOES
    get its own empty <td></td> -- that distinction is the entire point of
    the None-vs-TableCell(text="") grid encoding.

    border_style is the table-level `Table.border_style` value, threaded
    down here (rather than resolved once by the caller into a style
    fragment) because "grid" borders apply per-cell -- see table_color.py's
    table_style_attr docstring for why "outer" is instead applied once, on
    the <table> tag itself, by the caller."""
    cells_html: list[str] = []
    for cell in row:
        if cell is None:
            continue
        attrs = ""
        if cell.colspan > 1:
            attrs += f' colspan="{cell.colspan}"'
        if cell.rowspan > 1:
            attrs += f' rowspan="{cell.rowspan}"'
        style_parts: list[str] = []
        if cell.align is not None:
            # SAFE BY CONSTRUCTION, not defensively re-validated here:
            # `align` is a Literal["left","center","right","justify"] | None
            # field on the TableCell pydantic model, so any value that
            # reaches this line has already been validated to one of
            # exactly those 4 literals -- pydantic itself is the guard.
            # This IS NOT a precedent for the background/text colors right
            # below: those are plain `str | None` (not a closed Literal),
            # so resolve_cell_style_colors runs them through real runtime
            # hex validation (table_color.py's validate_hex_color) before
            # they can ever reach this style attribute -- never copy this
            # align shortcut for a color value.
            style_parts.append(f"text-align:{cell.align}")
        background_css, text_css = resolve_cell_style_colors(cell.background_color, cell.text_color)
        if background_css is not None:
            style_parts.append(f"background-color:{background_css}")
        if text_css is not None:
            style_parts.append(f"color:{text_css}")
        if border_style == "grid":
            # Per-cell border, deliberately with NO color component -- see
            # table_color.border_css's docstring for why (currentColor
            # theme adaptation). "outer" is handled once on <table> itself
            # by the caller, not per-cell.
            style_parts.append("border:1px solid")
        if style_parts:
            attrs += f' style="{";".join(style_parts)}"'
        cell_text = html.escape(cell.text)
        if cell.bold:
            # Semantic <b>, not a font-weight style declaration -- consistent
            # with border_css's currentColor approach elsewhere in this file:
            # theme-independent by construction, nothing to contrast-adapt.
            cell_text = f"<b>{cell_text}</b>"
        cells_html.append(f"<{cell_tag}{attrs}>{cell_text}</{cell_tag}>")
    return "<tr>" + "".join(cells_html) + "</tr>"


def _table_to_html(table: Table) -> str:
    """Renders a Table's TableCell grid as a real semantic HTML <table>,
    preserving row/column structure AND colspan/rowspan/is_header/caption
    for ADO's System.Description field (a rich-HTML field, not plain text)
    -- full rewrite of the schema-migration compat shim that used to flatten
    everything back to bare <tr><td> with no styling (Phase 1 of
    docs/superpowers/specs/2026-08-12-table-fidelity-design.md). Output is
    kept on a SINGLE line with no embedded newlines -- the orchestrator's
    description-html.ts TABLE_BLOCK_PATTERN and the frontend's TrustedTable
    matcher both assume/require a single-line block.

    thead/tbody grouping rule: only a LEADING run of header rows (every
    real cell in the row is_header=True, checked from row index 0) is
    wrapped in one <thead>; every row after the first non-header row --
    including any later row that individually still qualifies as a header
    row -- goes into one <tbody> (still rendered with <th> cells, just not
    inside a second <thead>). This is a deliberate simplification: standard
    HTML only supports a single <thead>/<tbody> pair per table, so a
    document with header rows in a structurally odd position (e.g. a
    repeated header mid-table) cannot be represented with more than one
    <thead> without inventing non-standard structure -- not done here.

    Fully-blank rows (every real cell's text is empty after stripping) are
    RENDERED, not skipped -- confirmed real gap (reported live): a source
    table can use a genuinely empty row as a deliberate visual spacer
    between two labeled sub-sections stacked inside one physical table
    (e.g. two sequential "SRU module / QTY / ..." blocks separated by one
    blank row), and dropping that row silently collapsed the visual
    separation the document's own author put there, even though the row
    itself carries no text or styling to preserve. Rendered through the
    SAME `_render_table_row` path as any other row -- each of its real
    cells (which all have `text=""`) becomes its own empty `<td></td>`,
    exactly the existing "a real TableCell with empty text is a genuine
    gap, not a spanned position" convention already used everywhere else
    in this model (see the None-vs-TableCell(text="") distinction
    documented on `Table.cells` itself) -- not a special-cased bare
    `<tr></tr>`, which is reserved for the structurally different
    fully-absorbed case directly below.

    A row made ENTIRELY of None positions (fully absorbed by rowspans from
    earlier rows -- e.g. every column in that source row is covered by a
    taller cell above it) IS still special-cased to a bare `<tr></tr>`, for
    a different reason than a blank row: there are no real TableCell
    objects here to hand to `_render_table_row` at all -- every position is
    a span continuation. Rationale for keeping the row itself (not
    skipping it either): skipping it would shrink the rendered <tr> count
    below the table's real row count, and HTML's rowspan is resolved
    purely by physical <tr> position in the rendered output -- a rowspan
    covering 3+ physical rows with a fully-absorbed row omitted from the
    middle would then overflow into a LATER row's cells that were never
    meant to be covered, corrupting that row's alignment too.

    Cell text (and caption) is HTML-escaped (html.escape) since it is
    untrusted source-document content about to be embedded in an HTML
    field."""
    # Bail out entirely (matches the pre-rewrite contract: a wholly blank
    # table produces no HTML at all, so its caller skips creating a node
    # for it) if there is genuinely no content anywhere in the grid --
    # checked directly over every cell, independent of the per-row
    # blank/header/fully-absorbed classification below.
    if not any(cell is not None and cell.text.strip() for row in table.cells for cell in row):
        return ""

    thead_rows: list[str] = []
    tbody_rows: list[str] = []
    still_leading = True  # False once the first non-header kept row is seen
    for row in table.cells:
        if all(cell is None for cell in row):
            # Fully-absorbed structural row -- see docstring above.
            still_leading = False
            tbody_rows.append("<tr></tr>")
            continue
        if still_leading and _row_is_header(row):
            thead_rows.append(_render_table_row(row, "th", table.border_style))
            continue
        still_leading = False
        tbody_rows.append(_render_table_row(row, "th" if _row_is_header(row) else "td", table.border_style))

    caption_html = (
        f"<caption>{html.escape(table.caption)}</caption>"
        if table.caption and table.caption.strip()
        else ""
    )
    thead_html = f"<thead>{''.join(thead_rows)}</thead>" if thead_rows else ""
    tbody_html = f"<tbody>{''.join(tbody_rows)}</tbody>" if tbody_rows else ""
    # colgroup MUST be the first child of <table> per the HTML spec's
    # required child order (see colgroup_html's own docstring) -- placed
    # before caption_html/thead_html/tbody_html accordingly. table_style_attr
    # carries width:100% (only meaningful alongside colgroup's percentages)
    # and, for an "outer" border, the border itself -- "grid" borders are
    # instead applied per-cell above, see table_style_attr's own docstring
    # for why the two variants attach at different levels.
    table_attrs = table_style_attr(table.border_style, table.column_widths is not None)
    colgroup = colgroup_html(table.column_widths)
    return f"<table{table_attrs}>{colgroup}{caption_html}{thead_html}{tbody_html}</table>"


def _order_key(ref: SourceRef) -> tuple[int, int]:
    """Document-order sort key comparable across a Block and a Table within
    the SAME loader run. Offsets are NOT globally comparable on their own --
    pdf_loader.py resets its running offset counter to 0 at the start of
    EVERY page, so two different pages' start_offsets are meaningless
    relative to each other without the page number. docx/txt/md loaders
    never set `page` (None), where offset alone is already a real
    document-global position -- `ref.page or 0` collapses that case to a
    single implicit page 0, so the (page, offset) pair degrades correctly
    to offset-only ordering for those loaders."""
    return (ref.page or 0, ref.start_offset)


def _partition_tables_by_branch(branches: list[list[Block]], tables: list[Table]) -> list[list[Table]]:
    """Buckets each table into the top-level branch it falls within, by
    document order (_order_key) -- used so a table folds into the parent
    node ITS branch produced (§F/ADO 294208 etc's ECS/FAN/GPU/routing
    tables all live inside their real parent's Description), not always
    the last node of the last branch regardless of the table's actual
    position (the previous, now-removed behavior).

    A table falls into the LAST branch whose first block's order-key is
    <= the table's own order-key; branches are already in document order
    (see _split_into_branches), so this is a simple forward scan. A table
    positioned before every branch's first block (order-key (0, 0) --
    e.g. a loader that never got the real-offset fix for tables) falls
    back to the first branch, same documented approximation SourceRef's
    own docstring already describes for a table's offset."""
    branch_starts = [_order_key(branch[0].source_ref) for branch in branches]
    buckets: list[list[Table]] = [[] for _ in branches]
    for table in tables:
        key = _order_key(table.source_ref)
        idx = 0
        for i, start in enumerate(branch_starts):
            if start <= key:
                idx = i
            else:
                break
        buckets[idx].append(table)
    return buckets


def _build_headingless_tree(doc: CanonicalDoc, customer_id: str | None) -> WorkItemTree:
    """Grouping-without-headings rule (original request, BASELINE mode):
    when a document has NO internal heading structure at all — every block
    resolves to depth=None via resolve_block_depth (no headings, no
    numbering labels) — it must still be organized into an Epic/Feature
    grouping rather than producing zero nodes (the prior behavior: with no
    depth==1 block ever appearing, the stack in build_baseline_tree's main
    loop never opens, so every unleveled block had nothing to fold into and
    was silently dropped).

    Also handles the table-only case (e.g. the xlsx loader, which never
    produces `doc.blocks` at all — only `doc.tables`): previously this
    function was only reached when `doc.blocks` was non-empty, so a
    table-only document fell through to the structured path in
    build_baseline_tree and produced an empty tree instead. Each table
    (xlsx: one per sheet) becomes its own Requirement child instead, its
    rows folded into an HTML <table> description via _table_to_html — a
    blank table (no non-empty rows) is skipped, not turned into an empty
    node.

    Synthesizes exactly one Epic and one child Feature — title/description
    derived from the document's filename (see _derive_doc_title), since
    there is no heading text to extract a title from — then folds every
    block (or, for a table-only document, every table) into its own
    Requirement child of that Feature, each verbatim (title/description
    extracted from the block/table exactly as in the structured path; only
    the two synthetic parent nodes are non-verbatim).
    """
    doc_title = _derive_doc_title(doc)
    first_source_ref = doc.blocks[0].source_ref if doc.blocks else doc.tables[0].source_ref

    epic = WorkItemNode(
        local_id="n0",
        type=WorkItemType.EPIC,
        parent_local_id=None,
        title=doc_title,
        description=doc_title,
        customer_id=customer_id,
        source_ref=first_source_ref,
        fidelity_hash=_hash_description(doc_title),
        identity_hash=_hash_identity(doc_title, first_source_ref),
        tags=[],
        mode=WorkItemMode.BASELINE,
        child_type=WorkItemType.FEATURE,
    )
    feature = WorkItemNode(
        local_id="n1",
        type=WorkItemType.FEATURE,
        parent_local_id=epic.local_id,
        title=doc_title,
        description=doc_title,
        customer_id=customer_id,
        source_ref=first_source_ref,
        fidelity_hash=_hash_description(doc_title),
        identity_hash=_hash_identity(doc_title, first_source_ref),
        tags=[],
        mode=WorkItemMode.BASELINE,
        child_type=WorkItemType.REQUIREMENT,
    )
    nodes: list[WorkItemNode] = [epic, feature]
    # No "open node" concept exists in this function (every block gets its
    # own node, never folded into a prior one) -- so an unsupported-content
    # diagnostic here always has node_ids=[], unlike the structured path's
    # depth-is-None branch, which can attribute the same warning to a
    # currently-open node.
    warnings: list[IntegrityWarning] = []
    # section_path=[] is correct for every node this function builds (both
    # the two synthetic wrapper nodes above and every block/table node
    # below) -- there is no real heading ancestry in a headingless document,
    # and [] is already SourceRef.section_path's own default, so no
    # model_copy is needed anywhere in this function purely for that field.
    if doc.blocks:
        figure_map = figure_id_by_block_id(doc)
        fig_map = figures_by_id(doc.figures)
        for index, block in enumerate(doc.blocks):
            if _is_unsupported_content_note(block):
                # A loader diagnostic placeholder (e.g. pdf_loader.py's
                # multi-column false-positive note) must never become its
                # own work item -- see _is_unsupported_content_note's own
                # docstring. Dropped, not silently: recorded as a warning
                # instead (no node is ever "open" in this function, so
                # node_ids is always empty here).
                warnings.append(
                    IntegrityWarning.make(
                        WarningKind.UNSUPPORTED_CONTENT_NOTE,
                        f'A loader diagnostic note ("{block.text}") was stripped instead of '
                        "leaking into the proposed tree as if it were real content.",
                        detail={"kind": "block", "sourceId": block.id, "text": block.text},
                    )
                )
                continue
            description = block.text
            # This function gives every block its own node (no folding into
            # a prior "open" node the way build_baseline_tree's structured
            # path does), so a FIGURE-kind block's figure/uncaptioned id
            # attributes to that SAME node -- there is no earlier node to
            # fold it into. `description` deliberately keeps its existing
            # raw block.text shape (unchanged by this fix -- see
            # _figure_line's own "[FIGURE: none]" leak warning, a
            # pre-existing, separate concern this task doesn't touch); only
            # the new id lists are populated here.
            figure_ids: list[str] = []
            uncaptioned_figure_ids: list[str] = []
            insignificant_figure_ids: list[str] = []
            if block.kind == BlockKind.FIGURE:
                figure_id = figure_map.get(block.id)
                if figure_id is not None:
                    if _figure_line(block) is not None:
                        figure_ids = [figure_id]
                    else:
                        uncaptioned_figure_ids = [figure_id]
                        figure = fig_map.get(figure_id)
                        if figure is not None and figure.caption_status == "insignificant":
                            insignificant_figure_ids = [figure_id]
            nodes.append(
                WorkItemNode(
                    local_id=f"n{index + 2}",
                    type=WorkItemType.REQUIREMENT,
                    parent_local_id=feature.local_id,
                    title=extract_baseline_title(description),
                    description=description,
                    customer_id=customer_id,
                    source_ref=block.source_ref,
                    fidelity_hash=_hash_description(description),
                    identity_hash=_hash_identity(description, block.source_ref),
                    tags=[],
                    figure_ids=figure_ids,
                    uncaptioned_figure_ids=uncaptioned_figure_ids,
                    insignificant_figure_ids=insignificant_figure_ids,
                    mode=WorkItemMode.BASELINE,
                    child_type=WorkItemType.REQUIREMENT,
                )
            )
    else:
        for index, table in enumerate(doc.tables):
            description = _table_to_html(table)
            if not description.strip():
                continue
            title = table.caption or f"Table {index + 1}"
            nodes.append(
                WorkItemNode(
                    local_id=f"n{index + 2}",
                    type=WorkItemType.REQUIREMENT,
                    parent_local_id=feature.local_id,
                    title=extract_baseline_title(title),
                    description=description,
                    customer_id=customer_id,
                    source_ref=table.source_ref,
                    fidelity_hash=_hash_description(description),
                    identity_hash=_hash_identity(description, table.source_ref),
                    tags=[],
                    table_ids=[table.id],
                    mode=WorkItemMode.BASELINE,
                    child_type=WorkItemType.REQUIREMENT,
                )
            )
    return WorkItemTree(nodes=nodes, warnings=finalize_warnings(warnings))


def _build_flat_list_tree(doc: CanonicalDoc, branches: list[list[Block]], customer_id: str | None) -> WorkItemTree:
    """Flat single-column list rule: a document where every top-level branch
    is exactly one lone block (numbering resolves a depth, e.g. '1 Do X',
    '2 Do Y', but nothing ever nests under any of them) would otherwise fall
    through to the structured per-branch loop below and produce N
    independent top-level nodes with no parent -- each lone block has zero
    children, so classify_numbering_branch's bottom-up rule gives it
    Requirement, with no Epic/Feature to group them under at all. That is
    inconsistent with _build_headingless_tree's Epic/Feature synthesis for
    the no-numbering case, and loses the list's own "these are all one flat
    set of requirements" structure.

    Synthesizes the same Epic/Feature wrapper as _build_headingless_tree
    (title/description derived from the filename, since a flat list has no
    single unifying heading of its own), then folds each flat item into its
    own Requirement child, using its numbering-stripped display text (not
    the raw block text with the numbering label still attached) as both
    title and description -- each item genuinely is one requirement, not a
    Feature in its own right."""
    doc_title = _derive_doc_title(doc)
    first_source_ref = branches[0][0].source_ref

    epic = WorkItemNode(
        local_id="n0", type=WorkItemType.EPIC, parent_local_id=None,
        title=doc_title, description=doc_title, customer_id=customer_id,
        source_ref=first_source_ref, fidelity_hash=_hash_description(doc_title),
        identity_hash=_hash_identity(doc_title, first_source_ref),
        tags=[], mode=WorkItemMode.BASELINE, child_type=WorkItemType.FEATURE,
    )
    feature = WorkItemNode(
        local_id="n1", type=WorkItemType.FEATURE, parent_local_id=epic.local_id,
        title=doc_title, description=doc_title, customer_id=customer_id,
        source_ref=first_source_ref, fidelity_hash=_hash_description(doc_title),
        identity_hash=_hash_identity(doc_title, first_source_ref),
        tags=[], mode=WorkItemMode.BASELINE, child_type=WorkItemType.REQUIREMENT,
    )
    # section_path=[] is correct throughout this function, same reasoning as
    # _build_headingless_tree's identical comment -- a flat numbered list
    # has no heading ancestry to record, and [] is already
    # SourceRef.section_path's own default.
    figure_map = figure_id_by_block_id(doc)
    fig_map = figures_by_id(doc.figures)
    nodes: list[WorkItemNode] = [epic, feature]
    for index, branch in enumerate(branches):
        block = branch[0]
        _, display_text = resolve_block_depth(block)
        # Every branch here is, by this function's own gate
        # (build_baseline_tree: "all(len(branch) == 1 ...)"), a single
        # depth-resolving block -- a FIGURE-kind block never resolves a
        # depth (resolve_block_depth has no heading_level/numbering signal
        # for it), so this is unreachable via that gate today. Handled
        # anyway (same fold logic as every other path) for a caller that
        # invokes this function directly with a hand-built branch, and so
        # this function's own behavior doesn't silently diverge from
        # _build_headingless_tree's if that invariant ever changes.
        figure_ids: list[str] = []
        uncaptioned_figure_ids: list[str] = []
        insignificant_figure_ids: list[str] = []
        if block.kind == BlockKind.FIGURE:
            figure_id = figure_map.get(block.id)
            if figure_id is not None:
                if _figure_line(block) is not None:
                    figure_ids = [figure_id]
                else:
                    uncaptioned_figure_ids = [figure_id]
                    figure = fig_map.get(figure_id)
                    if figure is not None and figure.caption_status == "insignificant":
                        insignificant_figure_ids = [figure_id]
        nodes.append(
            WorkItemNode(
                local_id=f"n{index + 2}", type=WorkItemType.REQUIREMENT, parent_local_id=feature.local_id,
                title=extract_baseline_title(display_text), description=display_text, customer_id=customer_id,
                source_ref=block.source_ref, fidelity_hash=_hash_description(display_text),
                identity_hash=_hash_identity(display_text, block.source_ref),
                tags=[], figure_ids=figure_ids, uncaptioned_figure_ids=uncaptioned_figure_ids,
                insignificant_figure_ids=insignificant_figure_ids,
                mode=WorkItemMode.BASELINE, child_type=WorkItemType.REQUIREMENT,
            )
        )
    return WorkItemTree(nodes=nodes)


def build_baseline_tree(doc: CanonicalDoc, customer_id: str | None = None) -> WorkItemTree:
    """Deterministic BASELINE-mode leveling: no LLM involved. Splits the
    document into top-level branches, auto-detects a profile per branch
    (see autodetect.py), then walks each branch's blocks maintaining a
    depth stack to assign parent/child relationships. Unleveled blocks
    (plain paragraphs, list items, notes, OPEN/TBD markers, inline figure
    placeholders) extend the nearest currently-open node's description
    rather than becoming their own node.

    fidelity_hash is recomputed every time a node's description changes
    (both at creation and on every subsequent fold), so it always equals
    sha256(description) for the node's FINAL, fully-folded description —
    not just the block that originally created the node. See
    app/workitem/fidelity.py's verify_fidelity for the standalone
    drift-detection check this invariant enables.

    Each doc.tables entry is folded into the Description of whichever node
    is open at its real document-order position (via _order_key/
    _partition_tables_by_branch below) -- exactly like a depth=None block
    already folds into the nearest open node, and for the same reason: a
    table belongs INSIDE its parent item's Description, never as its own
    separate work item (see docs/architecture.md and the AirPro ICD's own
    294208/294209/294210/294248/294611, all tables living inside their
    parent's Description, not as standalone Requirements). This replaces
    a previous design where every table was emitted as its OWN Requirement,
    appended after all block-leveling regardless of the table's real
    position -- correct only for the table-only case (e.g. xlsx, whose
    loader never produces doc.blocks at all; still handled that way via
    _build_headingless_tree, since there an xlsx sheet genuinely has no
    parent block to fold into) but wrong for any document that ALSO has
    real heading blocks.

    customer_id is a single value applied uniformly to every node in this
    call — one ingestion run corresponds to one customer's document, per
    docs/architecture.md's idempotency key (source_hash, customer_id,
    area_path) -> System.Id. It is NOT parsed or extracted from document
    content.

    Grouping-without-headings rule: if the document has no heading/numbering
    structure at all (every block resolves depth=None), OR has no blocks at
    all but does have tables (e.g. an xlsx document — its loader never
    produces doc.blocks), this delegates to _build_headingless_tree rather
    than falling through to the structured path below, which would silently
    produce zero nodes for either case.

    Flat single-column list rule: if EVERY top-level branch is a single lone
    block (numbering resolves a depth, but nothing ever nests under any of
    them -- e.g. '1 Do X' / '2 Do Y' / '3 Do Z' with no sub-items), this
    delegates to _build_flat_list_tree instead of the structured per-branch
    loop below, which would otherwise classify each single-block (zero
    children) branch as its own orphan Requirement with no parent -- N
    orphan top-level Requirements instead of one grouped
    Epic/Feature/Requirement* tree. Requires more than one branch: a
    document with a single flat item is too ambiguous to confidently
    regroup and is left to the structured path (produces one ungrouped
    Requirement, an acceptable minimal case)."""
    if (doc.blocks and all(resolve_block_depth(b)[0] is None for b in doc.blocks)) or (
        not doc.blocks and doc.tables
    ):
        return _build_headingless_tree(doc, customer_id)

    branches = _split_into_branches(doc)
    if len(branches) > 1 and all(len(branch) == 1 for branch in branches):
        return _build_flat_list_tree(doc, branches, customer_id)

    table_buckets = _partition_tables_by_branch(branches, doc.tables) if doc.tables else [[] for _ in branches]
    # Whole-document (not per-branch) block.id -> Figure.id map -- see
    # figure_id_by_block_id's own docstring. Built once, up front, since a
    # figure's block can never move between branches after
    # _split_into_branches (branches are a partition of doc.blocks).
    figure_map = figure_id_by_block_id(doc)
    fig_map = figures_by_id(doc.figures)

    nodes: list[WorkItemNode] = []
    nodes_by_id: dict[str, WorkItemNode] = {}
    node_counter = 0
    # BASELINE has no LLM step to produce a coverage mismatch the way SURVEY's
    # sanity check does (see WorkItemTree.warnings' own docstring), but it has
    # its own silent-loss case: a depth=None block/table with no node yet open
    # to fold into (its branch's first entry has no heading/numbering the
    # parser recognized -- see numbering.py) was previously just dropped with
    # no record anywhere. verify_fidelity (app/workitem/fidelity.py) cannot
    # catch this: a dropped entry never becomes part of any node's
    # description, so there is nothing to hash-mismatch against. Surfacing it
    # here closes that blind spot without changing behavior -- the entry is
    # still dropped, a human reviewer now has a chance to notice.
    warnings: list[IntegrityWarning] = []

    # Front-matter buffer: an orphan entry (table or block with no node yet
    # open to fold into) is typically the document's own preamble -- a cover
    # table, revision history, scope/intro prose preceding the first real
    # heading/numbering. Rather than dropping it, every orphan across the
    # whole document is buffered here and flushed ONCE, as a single
    # synthetic front-matter Requirement, as soon as the first real node is
    # created (see the flush right after that node's stack.append below).
    # Parented to that first real node -- almost always correct, since
    # _split_into_branches guarantees only the leading branch can produce an
    # orphan (every later branch's own first entry is what defines its
    # split boundary, so its node is already open by the time any sibling
    # entry is walked).
    orphan_entries: list[str] = []
    orphan_source_ref: SourceRef | None = None
    front_matter_flushed = False

    for branch_blocks, branch_tables in zip(branches, table_buckets):
        heading_branch = is_heading_style_branch(branch_blocks)
        # Numbering-label branches: bottom-up tree-shape classification (see
        # classify_numbering_branch's own docstring) replaces the retired
        # depth-threshold heuristic entirely -- no "profile" concept is
        # needed for this convention, the type comes out of the tree shape.
        # Heading-style branches skip this pre-pass -- their rule
        # (heading_style_type_for_depth) is depth-only and unconditional.
        classification = {} if heading_branch else classify_numbering_branch(branch_blocks)
        stack: list[tuple[int, str]] = []

        # Merge this branch's blocks and tables into one document-order walk
        # (_order_key) so a table folds into whichever node is open at its
        # REAL position, not always the branch's/document's last node
        # regardless of where the table actually appears. Python's sort is
        # stable, so a tied order_key (e.g. two entries both carrying a
        # loader's (0, 0) table placeholder) preserves this list's own
        # block-then-table construction order, matching the previous
        # append-after-blocks behavior for that specific edge case.
        merged: list[tuple[tuple[int, int], Block | None, Table | None]] = [
            (_order_key(block.source_ref), block, None) for block in branch_blocks
        ] + [(_order_key(table.source_ref), None, table) for table in branch_tables]
        merged.sort(key=lambda entry: entry[0])

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
                continue

            assert block is not None
            depth, display_text = resolve_block_depth(block)

            if depth is None:
                # figure_id is None for every non-FIGURE block (the common
                # case) -- looked up once here so both branches below (real
                # caption vs none) can use the SAME value without a second
                # BlockKind check.
                figure_id = figure_map.get(block.id) if block.kind == BlockKind.FIGURE else None
                if block.kind == BlockKind.FIGURE:
                    figure_line = _figure_line(block)
                    if figure_line is None:
                        # Caption failed / vision disabled / the vision call
                        # judged the figure insignificant (_figure_line returns
                        # None in all three cases -- see its own docstring):
                        # the literal placeholder must never reach
                        # `description`, same as before this field existed.
                        # The figure itself still exists in the source
                        # document though, so record it as uncaptioned on
                        # whatever node is currently open, instead of letting
                        # it vanish with zero trace. No open node yet (this
                        # branch's own leading front matter) has nowhere real
                        # to attach it to -- dropped silently, same as every
                        # other orphan entry that precedes a branch's first
                        # heading/numbering.
                        if stack and figure_id is not None:
                            nodes_by_id[stack[-1][1]].uncaptioned_figure_ids.append(figure_id)
                            figure = fig_map.get(figure_id)
                            if figure is not None and figure.caption_status == "insignificant":
                                nodes_by_id[stack[-1][1]].insignificant_figure_ids.append(figure_id)
                        continue
                    display_text = figure_line

                if _is_unsupported_content_note(block):
                    # A loader diagnostic placeholder (e.g. pdf_loader.py's
                    # multi-column false-positive note) must never be folded
                    # into a node's description as if it were real content --
                    # see _is_unsupported_content_note's own docstring.
                    # Attributed to whatever node is currently open (if any),
                    # same convention as the FIGURE-uncaptioned branch above.
                    node_ids = [stack[-1][1]] if stack else []
                    warnings.append(
                        IntegrityWarning.make(
                            WarningKind.UNSUPPORTED_CONTENT_NOTE,
                            f'A loader diagnostic note ("{block.text}") was stripped instead of '
                            "leaking into the proposed tree as if it were real content.",
                            node_ids=node_ids,
                            detail={"kind": "block", "sourceId": block.id, "text": block.text},
                        )
                    )
                    continue

                if stack:
                    open_node = nodes_by_id[stack[-1][1]]
                    open_node.description = assemble_description(open_node.description, display_text)
                    open_node.fidelity_hash = _hash_description(open_node.description)
                    open_node.identity_hash = _hash_identity(open_node.description, open_node.source_ref)
                    open_node.source_ref = _widen_page_end(open_node.source_ref, block.source_ref)
                    if figure_id is not None:
                        open_node.figure_ids.append(figure_id)
                else:
                    if orphan_source_ref is None:
                        orphan_source_ref = block.source_ref
                    orphan_entries.append(display_text)
                    preview = display_text[:80].replace("\n", " ")
                    warnings.append(
                        IntegrityWarning.make(
                            WarningKind.FRONT_MATTER_FOLDED,
                            f'A block of text ("{preview}") precedes any heading/numbering in its branch -- '
                            "folded into a synthetic front-matter node instead of being dropped.",
                            detail={"kind": "block", "sourceId": block.id, "preview": preview},
                        )
                    )
                continue

            if heading_branch:
                node_type = heading_style_type_for_depth(depth)
                node_child_type = WorkItemType.REQUIREMENT
            else:
                # display_text is replaced with the classifier's stripped
                # version -- only differs from resolve_block_depth's own
                # remainder for a SUB--marked node (the marker and its
                # adjacent separator are stripped from the title/description).
                entry = classification.get(block.id)
                if entry is not None:
                    node_type, node_child_type, display_text = entry
                else:
                    # A block inside a numbering-label branch (is_heading_style_branch
                    # is False for the branch overall, decided by the branch's root
                    # block only) that itself resolved via the heading path -- a real
                    # Word Heading style with non-numeric text, e.g. a "Notes"
                    # sub-heading -- has no entry here: classify_numbering_branch only
                    # classifies blocks whose OWN numbering label parses. Regression:
                    # indexing classification[block.id] directly raised an unhandled
                    # KeyError for this case, aborting the whole /level call. Fall back
                    # to the flat heading rule for this one block -- its own resolved
                    # signal was a heading, so that is the correct rule to borrow, not
                    # an arbitrary default.
                    node_type = heading_style_type_for_depth(depth)
                    node_child_type = WorkItemType.REQUIREMENT

            while stack and stack[-1][0] >= depth:
                stack.pop()
            parent_local_id = stack[-1][1] if stack else None

            local_id = f"n{node_counter}"
            node_counter += 1

            # `stack` at this point holds exactly this node's real ancestor
            # chain (its own entry hasn't been pushed yet) -- root-first,
            # since entries are appended in nesting order and popped from
            # the end above. Reusing it as section_path means no separate
            # heading-label bookkeeping is needed: the SAME structure that
            # decides parent_local_id also names the section path.
            # `.model_copy(update=...)` is required here, not a plain
            # `source_ref=block.source_ref` + later mutation -- pydantic v2
            # does not copy a nested BaseModel on assignment, so mutating
            # the new node's own source_ref in place would corrupt the
            # ORIGINAL Block's source_ref too (they'd be the same object).
            section_path = [nodes_by_id[ancestor_id].title for _ancestor_depth, ancestor_id in stack]
            node = WorkItemNode(
                local_id=local_id,
                type=node_type,
                parent_local_id=parent_local_id,
                title=extract_baseline_title(display_text),
                description=display_text,
                customer_id=customer_id,
                source_ref=block.source_ref.model_copy(update={"section_path": section_path}),
                fidelity_hash=_hash_description(display_text),
                identity_hash=_hash_identity(display_text, block.source_ref),
                tags=[],
                mode=WorkItemMode.BASELINE,
                child_type=node_child_type,
            )
            nodes.append(node)
            nodes_by_id[local_id] = node
            stack.append((depth, local_id))

            if orphan_entries and not front_matter_flushed:
                front_matter_flushed = True
                front_matter_text = orphan_entries[0]
                for extra in orphan_entries[1:]:
                    front_matter_text = assemble_description(front_matter_text, extra)
                front_matter_local_id = f"n{node_counter}"
                node_counter += 1
                front_matter_source_ref = orphan_source_ref if orphan_source_ref is not None else node.source_ref
                front_matter_node = WorkItemNode(
                    local_id=front_matter_local_id,
                    type=WorkItemType.REQUIREMENT,
                    parent_local_id=local_id,
                    title=f"Front Matter: {_derive_doc_title(doc)}",
                    description=front_matter_text,
                    customer_id=customer_id,
                    source_ref=front_matter_source_ref,
                    fidelity_hash=_hash_description(front_matter_text),
                    identity_hash=_hash_identity(front_matter_text, front_matter_source_ref),
                    tags=[],
                    mode=WorkItemMode.BASELINE,
                    child_type=WorkItemType.REQUIREMENT,
                )
                nodes.append(front_matter_node)
                nodes_by_id[front_matter_local_id] = front_matter_node

    return WorkItemTree(nodes=nodes, warnings=finalize_warnings(warnings))
