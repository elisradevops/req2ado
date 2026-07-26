from __future__ import annotations

import hashlib
import html
from pathlib import Path

from app.canonical.model import Block, CanonicalDoc, SourceRef, Table
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.autodetect import classify_numbering_branch, is_heading_style_branch
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import heading_style_type_for_depth
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
    it -- so this hash tracks the node's evolving description while staying
    anchored to a stable position, distinguishing two nodes whose
    description happens to become byte-identical."""
    return hashlib.sha256(f"{description}\x00{source_ref.document_path}\x00{source_ref.start_offset}".encode()).hexdigest()


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
                    identity_hash=_hash_identity(description, block.source_ref),
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
                    identity_hash=_hash_identity(description, table.source_ref),
                    tags=[],
                    mode=WorkItemMode.BASELINE,
                    child_type=WorkItemType.REQUIREMENT,
                )
            )
    return WorkItemTree(nodes=nodes)


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
    nodes: list[WorkItemNode] = [epic, feature]
    for index, branch in enumerate(branches):
        block = branch[0]
        _, display_text = resolve_block_depth(block)
        nodes.append(
            WorkItemNode(
                local_id=f"n{index + 2}", type=WorkItemType.REQUIREMENT, parent_local_id=feature.local_id,
                title=extract_baseline_title(display_text), description=display_text, customer_id=customer_id,
                source_ref=block.source_ref, fidelity_hash=_hash_description(display_text),
                identity_hash=_hash_identity(display_text, block.source_ref),
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
    warnings: list[str] = []

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
                else:
                    title_preview = table.caption or table.id
                    warnings.append(
                        f"Table {table.id} ({title_preview}) was dropped: no heading/numbering "
                        f"precedes it in its branch, so there was no node open to fold it into."
                    )
                continue

            assert block is not None
            depth, display_text = resolve_block_depth(block)

            if depth is None:
                if stack:
                    open_node = nodes_by_id[stack[-1][1]]
                    open_node.description = assemble_description(open_node.description, display_text)
                    open_node.fidelity_hash = _hash_description(open_node.description)
                    open_node.identity_hash = _hash_identity(open_node.description, open_node.source_ref)
                else:
                    preview = display_text[:80].replace("\n", " ")
                    warnings.append(
                        f"Block {block.id} was dropped: no heading/numbering precedes it in its "
                        f'branch, so there was no node open to fold it into. Text: "{preview}"'
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

            node = WorkItemNode(
                local_id=local_id,
                type=node_type,
                parent_local_id=parent_local_id,
                title=extract_baseline_title(display_text),
                description=display_text,
                customer_id=customer_id,
                source_ref=block.source_ref,
                fidelity_hash=_hash_description(display_text),
                identity_hash=_hash_identity(display_text, block.source_ref),
                tags=[],
                mode=WorkItemMode.BASELINE,
                child_type=node_child_type,
            )
            nodes.append(node)
            nodes_by_id[local_id] = node
            stack.append((depth, local_id))

    return WorkItemTree(nodes=nodes, warnings=warnings)
