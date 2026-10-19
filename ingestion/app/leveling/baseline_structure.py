from __future__ import annotations

from app.canonical.model import CanonicalDoc
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import IntegrityWarning, WorkItemMode, WorkItemNode

_ID_PREFIX = "bl_"


def adopt_baseline_structure(doc: CanonicalDoc) -> tuple[list[WorkItemNode], list[IntegrityWarning]]:
    """The items of `doc` as the BASELINE rules structure them, ready to join a SURVEY tree.

    The structure of a document that no deterministic detector claims used to be chosen by the chat model, so the number
    of items varied from run to run and from model to model. BASELINE structuring is a pure function of the document
    (headings and numbering by depth, a headingless document under one Epic and Feature, a table-only document with one
    item per sheet), for every format, so it is the fixed item set. The nodes are renamed (`bl_` prefix, so they cannot
    collide with the deterministic subtrees' ids), marked SURVEY (the later passes score and refine them like any SURVEY
    item) and keep their hashes, so a rerun produces the same identities."""
    tree = build_baseline_tree(doc)
    renamed = {node.local_id: f"{_ID_PREFIX}{node.local_id}" for node in tree.nodes}
    nodes: list[WorkItemNode] = []
    for node in tree.nodes:
        adopted = node.model_copy(
            update={
                "local_id": renamed[node.local_id],
                "parent_local_id": renamed.get(node.parent_local_id) if node.parent_local_id else None,
                "mode": WorkItemMode.SURVEY,
            }
        )
        nodes.append(adopted)
    warnings = [
        warning.model_copy(update={"node_ids": [renamed.get(node_id, node_id) for node_id in warning.node_ids]})
        for warning in tree.warnings
    ]
    return nodes, warnings
