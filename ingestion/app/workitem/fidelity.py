from __future__ import annotations

import hashlib

from app.workitem.model import WorkItemNode


def verify_fidelity(node: WorkItemNode) -> bool:
    """Re-derives sha256(node.description) and compares it to the node's
    stored fidelity_hash. This is the concrete mechanism behind
    docs/architecture.md's traceability guarantee: 're-hash on re-run
    detects drift' — if a node's description was mutated by anything after
    fidelity_hash was originally computed (see tree_builder.py's
    build_baseline_tree, which keeps the two in sync at build time), this
    returns False. Nodes with fidelity_hash=None (e.g. SURVEY mode, which
    makes no BASELINE fidelity guarantee) always return False rather than
    raising — there is nothing to verify, and that is reported honestly as
    'not verified', not conflated with 'verified.'"""
    if node.fidelity_hash is None:
        return False
    return hashlib.sha256(node.description.encode()).hexdigest() == node.fidelity_hash
