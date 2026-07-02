from __future__ import annotations

import hashlib

from app.canonical.model import Block, CanonicalDoc
from app.leveling.autodetect import detect_profile_for_branch
from app.leveling.depth import resolve_block_depth
from app.leveling.profiles import type_for_depth
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemTree


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


def build_baseline_tree(doc: CanonicalDoc) -> WorkItemTree:
    """Deterministic BASELINE-mode leveling: no LLM involved. Splits the
    document into top-level branches, auto-detects a profile per branch
    (see autodetect.py), then walks each branch's blocks maintaining a
    depth stack to assign parent/child relationships. Unleveled blocks
    (plain paragraphs, list items, notes, OPEN/TBD markers, inline figure
    placeholders) extend the nearest currently-open node's description
    rather than becoming their own node."""
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
                    nodes_by_id[stack[-1][1]].description += "\n" + display_text
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
                title=display_text.strip()[:256],
                description=display_text,
                customer_id=None,
                source_ref=block.source_ref,
                fidelity_hash=hashlib.sha256(display_text.encode()).hexdigest(),
                tags=[],
                mode=WorkItemMode.BASELINE,
            )
            nodes.append(node)
            nodes_by_id[local_id] = node
            stack.append((depth, local_id))

    return WorkItemTree(nodes=nodes)
