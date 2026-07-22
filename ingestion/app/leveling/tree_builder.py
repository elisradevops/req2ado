from __future__ import annotations

import hashlib
import html
from pathlib import Path

from app.canonical.model import Block, CanonicalDoc, Table
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.autodetect import detect_profile_for_branch
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import type_for_depth
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


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
    detect_profile_for_branch (tv_style vs icd_style) reasons over a
    branch's own max depth, and sub-splitting would change what profile a
    sub-chunk detects as compared to the original, whole section --
    a real behavior change BASELINE mode has no need for (it doesn't call
    an LLM, so branch size was never a timeout risk there in the first
    place).

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


def _derive_doc_title(doc: CanonicalDoc) -> str:
    """Filename-derived title for a document with no heading structure at
    all — there is no heading/numbered-line text to extract a title from,
    so this is the one BASELINE code path where a title is not a verbatim
    source-span extraction. See _build_headingless_tree."""
    stem = Path(doc.document.path).stem.replace("_", " ").replace("-", " ").strip()
    return extract_baseline_title(stem or "Untitled Document")


def _table_to_html(table: Table) -> str:
    """Renders a Table's rows as an HTML <table>, preserving row/column
    structure for ADO's System.Description field (a rich-HTML field, not
    plain text) -- replaces a previous pipe-delimited plain-text fold, which
    flattened every row into one line ADO could only ever display as a flat
    string, never as an actual table. Fully-blank rows are skipped, same as
    before. Cell text is HTML-escaped (html.escape) since it is untrusted
    source-document content about to be embedded in an HTML field."""
    rows_html = [
        "<tr>" + "".join(f"<td>{html.escape(cell)}</td>" for cell in row) + "</tr>"
        for row in table.rows
        if any(cell.strip() for cell in row)
    ]
    return f"<table>{''.join(rows_html)}</table>" if rows_html else ""


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
        tags=[],
        mode=WorkItemMode.BASELINE,
        child_type=WorkItemType.REQUIREMENT,
    )
    nodes: list[WorkItemNode] = [epic, feature]
    if doc.blocks:
        for index, block in enumerate(doc.blocks):
            description = block.text
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
                    tags=[],
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
                    tags=[],
                    mode=WorkItemMode.BASELINE,
                    child_type=WorkItemType.REQUIREMENT,
                )
            )
    return WorkItemTree(nodes=nodes)


def _build_flat_list_tree(doc: CanonicalDoc, branches: list[list[Block]], customer_id: str | None) -> WorkItemTree:
    """Flat single-column list rule: a document where every top-level branch
    is exactly one lone block (numbering resolves a depth, e.g. '1 Do X',
    '2 Do Y', but nothing ever nests under any of them) previously fell
    through the structured per-branch loop below and produced N independent
    top-level Feature nodes with no parent -- each branch auto-detected as
    icd_style at max_depth=1, and type_for_depth(icd_style, 1) is Feature,
    with no Epic to group them under. That is inconsistent with
    _build_headingless_tree's Epic/Feature synthesis for the no-numbering
    case, and loses the list's own "these are all one flat set of
    requirements" structure.

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
        tags=[], mode=WorkItemMode.BASELINE, child_type=WorkItemType.FEATURE,
    )
    feature = WorkItemNode(
        local_id="n1", type=WorkItemType.FEATURE, parent_local_id=epic.local_id,
        title=doc_title, description=doc_title, customer_id=customer_id,
        source_ref=first_source_ref, fidelity_hash=_hash_description(doc_title),
        tags=[], mode=WorkItemMode.BASELINE, child_type=WorkItemType.REQUIREMENT,
    )
    nodes: list[WorkItemNode] = [epic, feature]
    for index, branch in enumerate(branches):
        block = branch[0]
        _, display_text = resolve_block_depth(block)
        nodes.append(
            WorkItemNode(
                local_id=f"n{index + 2}", type=WorkItemType.REQUIREMENT, parent_local_id=feature.local_id,
                title=extract_baseline_title(display_text), description=display_text, customer_id=customer_id,
                source_ref=block.source_ref, fidelity_hash=_hash_description(display_text),
                tags=[], mode=WorkItemMode.BASELINE, child_type=WorkItemType.REQUIREMENT,
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

    doc.blocks are leveled first in the structured path below; any doc.tables
    are then folded in afterward, each as its own Requirement child of the
    LAST node produced by the block-leveling pass (see the fold at the end
    of this function). Previously a document with BOTH real heading blocks
    AND tables silently dropped every table — only the table-only case (e.g.
    xlsx, whose loader never produces doc.blocks at all) was handled, via
    the headingless-grouping check just below delegating to
    _build_headingless_tree. Attaching to the last block-node is a
    documented approximation: CanonicalDoc's SourceRef gives tables a
    placeholder (0, 0) offset (see SourceRef's own docstring), so there is
    no real document-order signal to interleave a table at its true
    position among the blocks — "after everything else" is the best
    available default, not a precise placement.

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
    loop below, which would otherwise auto-detect each single-block branch
    as its own icd_style Feature with no parent -- N orphan top-level
    Features instead of one grouped Epic/Feature/Requirement* tree. Requires
    more than one branch: a document with a single flat item is too
    ambiguous to confidently regroup and is left to the structured path
    (produces one ungrouped Feature, an acceptable minimal case)."""
    if (doc.blocks and all(resolve_block_depth(b)[0] is None for b in doc.blocks)) or (
        not doc.blocks and doc.tables
    ):
        return _build_headingless_tree(doc, customer_id)

    branches = _split_into_branches(doc)
    if len(branches) > 1 and all(len(branch) == 1 for branch in branches):
        return _build_flat_list_tree(doc, branches, customer_id)

    nodes: list[WorkItemNode] = []
    nodes_by_id: dict[str, WorkItemNode] = {}
    node_counter = 0

    for branch_blocks in branches:
        profile = detect_profile_for_branch(branch_blocks)
        stack: list[tuple[int, str]] = []

        for block in branch_blocks:
            depth, display_text = resolve_block_depth(block)

            if depth is None:
                if stack:
                    open_node = nodes_by_id[stack[-1][1]]
                    open_node.description = assemble_description(open_node.description, display_text)
                    open_node.fidelity_hash = _hash_description(open_node.description)
                continue

            while stack and stack[-1][0] >= depth:
                stack.pop()
            parent_local_id = stack[-1][1] if stack else None

            local_id = f"n{node_counter}"
            node_counter += 1

            node = WorkItemNode(
                local_id=local_id,
                type=type_for_depth(profile, depth),
                parent_local_id=parent_local_id,
                title=extract_baseline_title(display_text),
                description=display_text,
                customer_id=customer_id,
                source_ref=block.source_ref,
                fidelity_hash=_hash_description(display_text),
                tags=[],
                mode=WorkItemMode.BASELINE,
                child_type=type_for_depth(profile, depth + 1),
            )
            nodes.append(node)
            nodes_by_id[local_id] = node
            stack.append((depth, local_id))

    if doc.tables:
        parent_local_id = nodes[-1].local_id if nodes else None
        for index, table in enumerate(doc.tables):
            description = _table_to_html(table)
            if not description.strip():
                continue
            title = table.caption or f"Table {index + 1}"
            local_id = f"n{node_counter}"
            node_counter += 1
            nodes.append(
                WorkItemNode(
                    local_id=local_id,
                    type=WorkItemType.REQUIREMENT,
                    parent_local_id=parent_local_id,
                    title=extract_baseline_title(title),
                    description=description,
                    customer_id=customer_id,
                    source_ref=table.source_ref,
                    fidelity_hash=_hash_description(description),
                    child_type=WorkItemType.REQUIREMENT,
                    tags=[],
                    mode=WorkItemMode.BASELINE,
                )
            )

    return WorkItemTree(nodes=nodes)
