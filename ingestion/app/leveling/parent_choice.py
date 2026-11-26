"""R1's model step (owner, 2026-11-26: "repair it, and let the AI decide how"). When the tree is built, code never leaves a Feature or a
Requirement without a parent: hierarchy_rules.ensure_ladder puts every such item under one Epic named after the document (the
CATCHALL_EPIC_WRAP warning). That keeps the ladder, but the document's name is rarely where the item belongs.

In /level, after the build, the study model chooses each such item's parent from the places code offers: the items the ladder allows above
it (an Epic or Feature for a Feature; a Feature or Requirement for a Requirement), the nearest in the file first, and the document-named Epic
code chose. The model only picks one offered id, with a reason; code applies it, removes a document-named Epic or Feature left with nothing
under it, and reports every move (PARENT_CHOSEN) for the reviewer. An answer that names no offered option, or a failed call, keeps code's
placement: the ladder holds either way.
"""

from __future__ import annotations

from typing import Protocol

from app.leveling.hierarchy_rules import _VALID_PARENT
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode

MAX_TARGETS = 12  # the nearest allowed parents an item may move under: the model judges among these, never the whole file
_EXCERPT_CHARS = 200
_CHILDREN_SHOWN = 5
KEEP = "o0"  # the option that keeps code's placement under the document-named Epic


class ParentChoiceClient(Protocol):
    def choose_parents(self, items_by_id: dict[str, dict], user_id: str | None = None) -> dict[str, dict]: ...


def _excerpt(node: WorkItemNode) -> str:
    text = " ".join(node.description.split())
    return text if len(text) <= _EXCERPT_CHARS else text[: _EXCERPT_CHARS - 1].rstrip() + "…"


def _wrapped(warnings: list[IntegrityWarning]) -> tuple[IntegrityWarning, list[str]] | None:
    """The catch-all warning and the items it wrapped (every node id after the Epic's own)."""
    warning = next((w for w in warnings if w.kind == WarningKind.CATCHALL_EPIC_WRAP), None)
    return (warning, list(warning.node_ids[1:])) if warning is not None else None


def parent_options(nodes: list[WorkItemNode], node_id: str, synthetic: set[str]) -> dict[str, str]:
    """Option id -> parent id for `node_id`: its current (code-chosen) parent as KEEP, then the items the ladder allows above it, never itself,
    anything under it or another document-named item, the nearest in file order first."""
    by_id = {n.local_id: n for n in nodes}
    node = by_id[node_id]
    under = {node_id}
    grew = True
    while grew:
        grew = False
        for n in nodes:
            if n.parent_local_id in under and n.local_id not in under:
                under.add(n.local_id)
                grew = True
    order = {n.local_id: i for i, n in enumerate(nodes)}
    targets = [
        n
        for n in nodes
        if n.local_id not in under and n.local_id not in synthetic and n.type in _VALID_PARENT[node.type]
    ]
    targets.sort(key=lambda n: abs(order[n.local_id] - order[node_id]))
    options = {KEEP: node.parent_local_id or ""}
    options.update({f"o{i}": n.local_id for i, n in enumerate(targets[:MAX_TARGETS], 1)})
    return options


def _payload(by_id: dict[str, WorkItemNode], node: WorkItemNode, options: dict[str, str]) -> dict:
    return {
        "type": node.type.value,
        "title": node.title,
        "excerpt": _excerpt(node),
        "children": [
            {"type": c.type.value, "title": c.title}
            for c in [n for n in by_id.values() if n.parent_local_id == node.local_id][:_CHILDREN_SHOWN]
        ],
        "options": {
            option_id: {"type": by_id[parent_id].type.value, "title": by_id[parent_id].title, "excerpt": _excerpt(by_id[parent_id])}
            for option_id, parent_id in options.items()
            if parent_id in by_id
        },
    }


def choose_parents(
    nodes: list[WorkItemNode], warnings: list[IntegrityWarning], client: ParentChoiceClient, user_id: str | None = None
) -> int:
    """Moves each item code wrapped under the document-named Epic to the parent the model chose among the offered ones; returns how many
    moved. Fail-open: a failed call or an answer naming no offered option keeps code's placement."""
    found = _wrapped(warnings)
    if found is None:
        return 0
    catchall, wrapped = found
    by_id = {n.local_id: n for n in nodes}
    synthetic = {i for i in by_id if "synth_" in i}
    wrapped = [i for i in wrapped if i in by_id]
    # A wrapped Requirement sits under the document-named Feature: it is offered the same way.
    loose = [n.local_id for n in nodes if n.parent_local_id in synthetic and n.local_id not in synthetic and n.local_id not in wrapped]
    items = wrapped + loose
    if not items:
        return 0
    options = {i: parent_options(nodes, i, synthetic) for i in items}
    payload = {i: _payload(by_id, by_id[i], options[i]) for i in items}
    try:
        answer = client.choose_parents(payload, user_id=user_id)
    except Exception:  # noqa: BLE001 -- fail-open: code's placement keeps the ladder
        answer = {}
    moves = []
    for item_id in items:
        entry = answer.get(item_id) if isinstance(answer, dict) else None
        option = entry.get("option") if isinstance(entry, dict) else None
        if option is None or option == KEEP or option not in options[item_id]:
            continue
        node = by_id[item_id]
        moves.append({"id": item_id, "from": node.parent_local_id, "to": options[item_id][option], "reason": str(entry.get("reason", ""))[:300]})
        node.parent_local_id = options[item_id][option]
    if not moves:
        return 0
    # A document-named Epic or Feature that now holds nothing is not an item (R2).
    emptied = True
    while emptied:
        held = {n.parent_local_id for n in nodes}
        gone = {n.local_id for n in nodes if n.local_id in synthetic and n.local_id not in held}
        emptied = bool(gone)
        nodes[:] = [n for n in nodes if n.local_id not in gone]
    by_id = {n.local_id: n for n in nodes}
    if catchall.node_ids and catchall.node_ids[0] not in by_id:
        warnings.remove(catchall)
    names = "; ".join(f'"{by_id[m["id"]].title}" under "{by_id[m["to"]].title}"' for m in moves[:10]) + (" ..." if len(moves) > 10 else "")
    warnings.append(
        IntegrityWarning.make(
            WarningKind.PARENT_CHOSEN,
            f"{len(moves)} item(s) were left without a parent when the tree was built; the AI placed them where they belong: {names}.",
            node_ids=[m["id"] for m in moves],
            detail={"moves": moves},
        )
    )
    from app.leveling.id_tree_builder import recompute_child_types

    recompute_child_types(nodes)
    return len(moves)
