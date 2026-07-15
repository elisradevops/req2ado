from __future__ import annotations

import hashlib
from pathlib import Path

from app.canonical.model import Block, CanonicalDoc
from app.distillation.description import assemble_description
from app.distillation.title import extract_baseline_title
from app.leveling.autodetect import detect_profile_for_branch
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import type_for_depth
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemTree, WorkItemType


def _split_into_branches(doc: CanonicalDoc) -> list[list[Block]]:
    branches: list[list[Block]] = []
    current: list[Block] = []
    for block in doc.blocks:
        depth, _ = resolve_block_depth(block)
        if depth == 1 and current:
            branches.append(current)
            current = []
        current.append(block)
    if current:
        branches.append(current)
    return branches


def _hash_description(description: str) -> str:
    return hashlib.sha256(description.encode()).hexdigest()


def _derive_doc_title(doc: CanonicalDoc) -> str:
    """Filename-derived title for a document with no heading structure at
    all — there is no heading/numbered-line text to extract a title from,
    so this is the one BASELINE code path where a title is not a verbatim
    source-span extraction. See _build_headingless_tree."""
    stem = Path(doc.document.path).stem.replace("_", " ").replace("-", " ").strip()
    return extract_baseline_title(stem or "Untitled Document")


def _build_headingless_tree(doc: CanonicalDoc, customer_id: str | None) -> WorkItemTree:
    """Grouping-without-headings rule (original request, BASELINE mode):
    when a document has NO internal heading structure at all — every block
    resolves to depth=None via resolve_block_depth (no headings, no
    numbering labels) — it must still be organized into an Epic/Feature
    grouping rather than producing zero nodes (the prior behavior: with no
    depth==1 block ever appearing, the stack in build_baseline_tree's main
    loop never opens, so every unleveled block had nothing to fold into and
    was silently dropped).

    Synthesizes exactly one Epic and one child Feature — title/description
    derived from the document's filename (see _derive_doc_title), since
    there is no heading text to extract a title from — then folds every
    block into its own Requirement child of that Feature, each verbatim
    (title/description extracted from the block exactly as in the
    structured path; only the two synthetic parent nodes are non-verbatim).
    """
    doc_title = _derive_doc_title(doc)
    first_source_ref = doc.blocks[0].source_ref

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

    Only doc.blocks are leveled — doc.tables are not yet converted to work
    items (table-only documents, e.g. from the xlsx loader, currently
    produce an empty tree; this is a known scope gap for a later phase).

    customer_id is a single value applied uniformly to every node in this
    call — one ingestion run corresponds to one customer's document, per
    docs/architecture.md's idempotency key (source_hash, customer_id,
    area_path) -> System.Id. It is NOT parsed or extracted from document
    content.

    Grouping-without-headings rule: if the document has no heading/numbering
    structure at all (every block resolves depth=None), this delegates to
    _build_headingless_tree rather than falling through to the structured
    path below, which would silently produce zero nodes for such a
    document."""
    if doc.blocks and all(resolve_block_depth(b)[0] is None for b in doc.blocks):
        return _build_headingless_tree(doc, customer_id)

    nodes: list[WorkItemNode] = []
    nodes_by_id: dict[str, WorkItemNode] = {}
    node_counter = 0

    for branch_blocks in _split_into_branches(doc):
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

    return WorkItemTree(nodes=nodes)
