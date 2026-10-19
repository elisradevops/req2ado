from __future__ import annotations

import logging

from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode

logger = logging.getLogger(__name__)


def restore_lost_nodes(
    expected: list[WorkItemNode], nodes: list[WorkItemNode], warnings: list[IntegrityWarning], stage: str,
) -> list[str]:
    """Conservation check for the items that come straight from the document's own structure: every one of `expected`
    must still be in `nodes` after a processing stage. A node that went missing is put back (the same object, so its
    scores and text are kept; a parent that is gone is cleared, making it a root) and reported with a needs-review
    warning naming it, so an item can never disappear silently. Returns the restored ids (empty when nothing was lost)."""
    present = {node.local_id for node in nodes}
    lost = [node for node in expected if node.local_id not in present]
    if not lost:
        return []
    for node in lost:
        if node.parent_local_id is not None and node.parent_local_id not in present | {n.local_id for n in lost}:
            node.parent_local_id = None
        nodes.append(node)
    ids = [node.local_id for node in lost]
    message = (
        f"{len(ids)} item(s) from the document's own structure went missing during '{stage}' and were restored: "
        + ", ".join(f"'{node.title}'" for node in lost[:10])
        + (" ..." if len(lost) > 10 else "")
    )
    logger.error(message)
    warnings.append(
        IntegrityWarning.make(WarningKind.ITEMS_LOST, message, node_ids=ids, detail={"stage": stage}),
    )
    return ids
