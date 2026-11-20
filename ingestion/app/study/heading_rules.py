"""What a document's headings state about their own type, read before the shape rule types the rest.

A requirements document may label its headings with the type ("Feature: Power supply", "Requirement - Start-up time"). When the file does that
consistently, the label is the file's own statement of the type: it is final, and it is not part of the title. A label seen in only a few
headings is not a convention (a section called "Feature: overview" in a document that labels nothing else), so it is left alone.

The English labels are always recognised. A rulebook (study/model_rules.py: a model's validated answer, or the user's) adds the file's own labels
("יכולת:", "Capability –") and, when the document is consistent about it, the type of each nesting depth."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence

from app.study.rulebook import LabelRule
from app.workitem.model import WorkItemNode, WorkItemType

_NUMBER = r"(?P<number>\s*\d+(?:\.\d+)*\.?\s+)?"
_DEFAULT_LABEL = re.compile(
    _NUMBER + r"(?P<type>Epic|Feature|Requirement)\s*[:\-–—]\s+(?=\S)"
)
_TYPES = {
    "Epic": WorkItemType.EPIC,
    "Feature": WorkItemType.FEATURE,
    "Requirement": WorkItemType.REQUIREMENT,
}
MIN_LABELLED = 3
MIN_LABELLED_SHARE = 0.5


def _matchers(labels: Sequence[LabelRule] | None) -> list[tuple[re.Pattern[str], Callable[[re.Match[str]], WorkItemType]]]:
    """The patterns that read a label off a heading: the English ones, then one per label the rulebook names."""
    matchers: list[tuple[re.Pattern[str], Callable[[re.Match[str]], WorkItemType]]] = [
        (_DEFAULT_LABEL, lambda m: _TYPES[m.group("type")])
    ]
    for rule in labels or ():
        pattern = re.compile(
            _NUMBER + re.escape(rule.label) + r"\s*" + re.escape(rule.separator) + r"\s+(?=\S)",
            re.IGNORECASE,
        )
        matchers.append((pattern, lambda _m, t=_TYPES[rule.type]: t))
    return matchers


def _read(text: str, matchers: list) -> tuple[re.Match[str], WorkItemType] | None:
    for pattern, type_of in matchers:
        match = pattern.match(text)
        if match:
            return match, type_of(match)
    return None


def _without_label(text: str, match: re.Match[str]) -> str:
    return (match.group("number") or "").lstrip() + text[match.end() :]


def apply_stated_type_labels(
    nodes: list[WorkItemNode],
    rehash: Callable[[str], str],
    skip_ids: set[str] | frozenset[str] = frozenset(),
    labels: Sequence[LabelRule] | None = None,
) -> dict[str, WorkItemType]:
    """The types the headings state, by node id, when the file labels its headings as a convention; empty otherwise. The label is removed from the
    node's title and from the heading line at the top of its description (the number, if any, stays); `rehash(description)` gives the new fidelity hash.
    `labels` adds the rulebook's own labels to the English ones."""
    matchers = _matchers(labels)
    candidates = [n for n in nodes if n.local_id not in skip_ids]
    found = {n.local_id: _read(n.source_title or n.title, matchers) for n in candidates}
    labelled = [n for n in candidates if found[n.local_id]]
    if len(labelled) < MIN_LABELLED or len(labelled) / len(candidates) < MIN_LABELLED_SHARE:
        return {}
    locked: dict[str, WorkItemType] = {}
    for node in labelled:
        read = found[node.local_id]
        assert read is not None
        locked[node.local_id] = read[1]
        old_title = node.title
        in_title = _read(old_title, matchers)
        if in_title is not None:
            node.title = _without_label(old_title, in_title[0])
        source = node.source_title
        if source is not None:
            in_source = _read(source, matchers)
            node.source_title = _without_label(source, in_source[0]) if in_source else source
        first, newline, rest = node.description.partition("\n")
        in_first = _read(first, matchers)
        if in_first is not None and first.strip() == old_title.strip():
            node.description = _without_label(first, in_first[0]) + newline + rest
            node.fidelity_hash = rehash(node.description)
    return locked


def lock_types_by_depth(
    nodes: list[WorkItemNode],
    depth_types: Sequence[tuple[int, str]],
    locked: dict[str, WorkItemType],
    skip_ids: set[str] | frozenset[str] = frozenset(),
) -> dict[str, WorkItemType]:
    """Adds to `locked` the type a document states for each nesting depth (a rulebook's `depth_types`); a type already stated by a label stays. Depth
    is the number of ancestors a node has among `nodes`, 0 at a root. Depths the rulebook does not name are left to the shape rule."""
    if not depth_types:
        return locked
    by_depth = {depth: _TYPES[name] for depth, name in depth_types}
    by_id = {n.local_id: n for n in nodes}
    result = dict(locked)
    for node in nodes:
        if node.local_id in skip_ids or node.local_id in result:
            continue
        depth, seen, parent = 0, {node.local_id}, by_id.get(node.parent_local_id) if node.parent_local_id else None
        while parent is not None and parent.local_id not in seen:
            seen.add(parent.local_id)
            depth += 1
            parent = by_id.get(parent.parent_local_id) if parent.parent_local_id else None
        if depth in by_depth:
            result[node.local_id] = by_depth[depth]
    return result
