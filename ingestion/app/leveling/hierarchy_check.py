"""The hierarchy check of a table that states its items: SURVEY's model job for such a file, run in Analyze.

Code finds every item the Epic > Feature > Requirement ladder does not allow (study/file_rules.py, reported in the SOURCE_STRUCTURE_VIOLATION
warning rule_builder writes) and computes the fixes that would make each one valid: move it under another stated item, move it to the top level,
or give it another type. The model only picks one of those fixes per item, with a reason; it never proposes one of its own. Nothing is applied:
the pick is written into the warning for the user to decide, and an answer that names no offered fix leaves the decision to the user.

A file the ladder allows asks the model nothing."""

from __future__ import annotations

import logging
from typing import Protocol

from app.leveling.bounded_chunks import run_chunks_bounded
from app.leveling.rule_builder import is_rule_built
from app.study.file_rules import _VALID_PARENT, LADDER
from app.workitem.model import IntegrityWarning, WarningKind, WorkItemNode

logger = logging.getLogger(__name__)

_CHUNK = 40  # items per call: one call covers a typical file's violations
_MAX_MOVE_TARGETS = 12  # the nearest stated items an item may move under; the model judges among these, never the whole file
_EXCERPT_CHARS = 200
_CHILDREN_SHOWN = 5


class HierarchyFixClient(Protocol):
    def suggest_hierarchy_fixes(self, items_by_id: dict[str, dict], user_id: str | None = None) -> dict[str, dict]: ...


def _excerpt(node: WorkItemNode) -> str:
    text = " ".join(node.description.split())
    return text if len(text) <= _EXCERPT_CHARS else text[: _EXCERPT_CHARS - 1].rstrip() + "…"


def fix_options(nodes: list[WorkItemNode], node_id: str, misplaced: frozenset[str] = frozenset()) -> dict[str, dict]:
    """The fixes that make `node_id` an item the ladder allows, as option id -> {"action": "move_under", "parent_id"} | {"action": "move_to_top"}
    | {"action": "retype", "type"}. Only stated items are move targets, never the item itself, anything under it, or another item the ladder
    does not allow (`misplaced`: a fix must not lean on a placement that is itself wrong). Moves keep the item's
    children with it; a retype is offered only when the new type fits both its current parent and its current children."""
    by_id = {n.local_id: n for n in nodes}
    node = by_id[node_id]
    kind = node.type.value
    children = [n for n in nodes if n.parent_local_id == node_id]
    under: set[str] = {node_id}  # the item and everything below it
    grew = True
    while grew:
        grew = False
        for n in nodes:
            if n.parent_local_id in under and n.local_id not in under:
                under.add(n.local_id)
                grew = True

    parent = by_id.get(node.parent_local_id) if node.parent_local_id else None
    options: list[dict] = []
    if kind == "Epic" and parent is not None:
        options.append({"action": "move_to_top"})
    order = {n.local_id: i for i, n in enumerate(nodes)}
    ancestors: list[str] = []
    current = parent
    while current is not None:
        ancestors.append(current.local_id)
        current = by_id.get(current.parent_local_id) if current.parent_local_id else None
    targets = [
        n
        for n in nodes
        if is_rule_built(n.local_id)
        and n.local_id not in under
        and n.local_id not in misplaced
        and n.local_id != node.parent_local_id
        and n.type.value in _VALID_PARENT[kind]
    ]
    # The nearest valid ancestor first, then the nearest stated items in file order: the few places the item can plausibly belong.
    targets.sort(key=lambda n: (n.local_id not in ancestors, ancestors.index(n.local_id) if n.local_id in ancestors else 0, abs(order[n.local_id] - order[node_id])))
    options += [{"action": "move_under", "parent_id": n.local_id} for n in targets[:_MAX_MOVE_TARGETS]]
    for new_type in LADDER:
        if new_type == kind:
            continue
        fits_parent = new_type == "Epic" if parent is None else parent.type.value in _VALID_PARENT[new_type]
        if fits_parent and all(new_type in _VALID_PARENT[c.type.value] for c in children):
            options.append({"action": "retype", "type": new_type})
    return {f"o{i}": option for i, option in enumerate(options, 1)}


def _item_payload(by_id: dict[str, WorkItemNode], node: WorkItemNode, problem: str, options: dict[str, dict]) -> dict:
    parent = by_id.get(node.parent_local_id) if node.parent_local_id else None
    shown: dict[str, dict] = {}
    for option_id, option in options.items():
        if option["action"] == "move_under":
            target = by_id[option["parent_id"]]
            shown[option_id] = {"action": "move_under", "type": target.type.value, "title": target.title, "excerpt": _excerpt(target)}
        else:
            shown[option_id] = dict(option)
    return {
        "type": node.type.value,
        "title": node.title,
        "excerpt": _excerpt(node),
        "problem": problem,
        "parent": {"type": parent.type.value, "title": parent.title} if parent else None,
        "children": [
            {"type": c.type.value, "title": c.title}
            for c in [n for n in by_id.values() if n.parent_local_id == node.local_id][:_CHILDREN_SHOWN]
        ],
        "options": shown,
    }


def _sentence(by_id: dict[str, WorkItemNode], item: dict) -> str:
    node = by_id[item["id"]]
    what = f"{node.type.value} '{node.title[:60]}' ({item['problem']})"
    suggestion = item["suggestion"]
    if suggestion is None:
        return f"{what}: needs your decision"
    if suggestion["action"] == "move_under":
        fix = f"move under {by_id[suggestion['parent_id']].type.value} '{suggestion['parent_title'][:60]}'"
    elif suggestion["action"] == "move_to_top":
        fix = "move to the top level"
    else:
        fix = f"make it a {suggestion['type']}"
    return f"{what}: suggested: {fix} ({item['reason']})"


def suggest_hierarchy_fixes(
    nodes: list[WorkItemNode],
    warnings: list[IntegrityWarning],
    client: HierarchyFixClient,
    user_id: str | None = None,
    concurrency: int = 1,
) -> None:
    """Fills in the suggested fix of each item every SOURCE_STRUCTURE_VIOLATION warning in `warnings` names, in place. Fail-open: a failed call
    leaves its items as code reported them ("needs your decision"); the tree is never changed."""
    by_id = {n.local_id: n for n in nodes}
    found = [w for w in warnings if w.kind == WarningKind.SOURCE_STRUCTURE_VIOLATION and w.detail.get("items")]
    misplaced = frozenset(item["id"] for warning in found for item in warning.detail["items"])
    options_of: dict[str, dict[str, dict]] = {}
    payload: dict[str, dict] = {}
    for warning in found:
        for item in warning.detail["items"]:
            node = by_id.get(item["id"])
            if node is None:
                continue
            options = fix_options(nodes, node.local_id, misplaced)
            if options:
                options_of[node.local_id] = options
                payload[node.local_id] = _item_payload(by_id, node, item["problem"], options)
    if not payload:
        return
    ids = list(payload)
    chunks = [{i: payload[i] for i in ids[start : start + _CHUNK]} for start in range(0, len(ids), _CHUNK)]
    answers: dict[str, dict] = {}
    for outcome in run_chunks_bounded(chunks, lambda chunk: client.suggest_hierarchy_fixes(chunk, user_id=user_id), concurrency):
        if outcome.error is not None:
            logger.warning("Hierarchy check call failed (%s); its items stay without a suggestion.", type(outcome.error).__name__)
            continue
        if isinstance(outcome.value, dict):
            answers.update(outcome.value)
    for warning in found:
        for item in warning.detail["items"]:
            answer = answers.get(item["id"])
            option_id = answer.get("option") if isinstance(answer, dict) else None
            reason = answer.get("reason") if isinstance(answer, dict) else None
            option = options_of.get(item["id"], {}).get(option_id) if isinstance(option_id, str) else None
            if option is None or not isinstance(reason, str) or not reason.strip():
                continue  # no offered fix named: the decision stays with the user
            suggestion = dict(option)
            if option["action"] == "move_under":
                suggestion["parent_title"] = by_id[option["parent_id"]].title
            item["suggestion"] = suggestion
            item["reason"] = " ".join(reason.split())
        caption = warning.detail.get("source", "")
        warning.raw = (
            f"'{caption}' states a structure the Epic > Feature > Requirement ladder does not allow, kept as the file states it: "
            + "; ".join(_sentence(by_id, item) for item in warning.detail["items"] if item["id"] in by_id)
            + "."
        )
