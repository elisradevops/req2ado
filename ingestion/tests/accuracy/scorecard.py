"""Scores a built work-item tree against the ground truth of accuracy/variants.py."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from .variants import LADDER, TruthItem, ladder_items

# Markup that must never reach a stored description: real tags, and entities the source never wrote.
MARKUP = re.compile(
    r"</?\s*(div|b|ul|ol|li|br|p|span|strong|em|table)\b[^>]*>|&(amp|lt|gt|nbsp|quot);",
    re.IGNORECASE,
)
_NUMBER_PREFIX = re.compile(r"^\d+(\.\d+)*\.?\s+")
_TYPE_LABEL = re.compile(r"^(Epic|Feature|Requirement|אפיק|יכולת|דרישה)\s*[:\-–]\s*")


def key(text: str | None) -> str:
    text = _TYPE_LABEL.sub("", _NUMBER_PREFIX.sub("", text or ""))
    return re.sub(r"[^a-z0-9]+", " ", text.replace("–", "-").lower()).strip()[:50]


@dataclass
class Score:
    expected: Counter = field(default_factory=Counter)
    produced: Counter = field(default_factory=Counter)
    missing: list[str] = field(default_factory=list)
    retyped: list[str] = field(default_factory=list)
    wrong_parent: list[str] = field(default_factory=list)
    out_of_ladder_imported: list[str] = field(default_factory=list)
    markup_leaks: list[str] = field(default_factory=list)
    type_labels_in_titles: list[str] = field(default_factory=list)
    lost_text: list[str] = field(default_factory=list)
    lost_formatting: list[str] = field(default_factory=list)

    def problems(self) -> dict[str, list[str]]:
        return {
            name: value[:5]
            for name, value in vars(self).items()
            if isinstance(value, list) and value
        }

    def summary(self) -> str:
        counts = " ".join(f"{k}={len(v)}" for k, v in vars(self).items() if isinstance(v, list))
        return f"expected={dict(self.expected)} produced={dict(self.produced)} {counts} examples={self.problems()}"


def _title(node) -> str | None:
    return (node.source_title or node.title) if node is not None else None


def score(tree, *, rich: bool) -> Score:
    truth: list[TruthItem] = ladder_items()
    result = Score(
        expected=Counter(t.type for t in truth), produced=Counter(n.type.value for n in tree.nodes)
    )
    by_id = {n.local_id: n for n in tree.nodes}
    by_key: dict[str, list] = {}
    for node in tree.nodes:
        by_key.setdefault(key(_title(node)), []).append(node)
    for item in truth:
        candidates = by_key.get(key(item.title), [])
        if not candidates:
            result.missing.append(item.title[:60])
            continue
        parent_key = key(item.parent)
        node = next(
            (
                c
                for c in candidates
                if not parent_key or key(_title(by_id.get(c.parent_local_id))) == parent_key
            ),
            candidates[0],
        )
        if node.type.value != item.type:
            result.retyped.append(f"{item.type}->{node.type.value}: {item.title[:50]}")
        if item.parent and key(_title(by_id.get(node.parent_local_id))) != parent_key:
            result.wrong_parent.append(item.title[:50])
        # A heading's own number stays in its title (a Customer ID is read from it); a type label is not part of the title.
        if _TYPE_LABEL.match(node.title or ""):
            result.type_labels_in_titles.append(node.title[:50])
    for node in tree.nodes:
        if node.type.value not in LADDER:
            result.out_of_ladder_imported.append(node.title[:50])
        if MARKUP.search(node.description or ""):
            result.markup_leaks.append(node.title[:50])
    probe = next((t for t in truth if "Hierarchical command model" in t.title), None)
    node = next(iter(by_key.get(key(probe.title), [])), None) if probe else None
    if node is not None:
        text = node.description or ""
        if "Keep all station lists" not in text:
            result.lost_text.append(probe.title)
        if rich and not (
            "**Engineering Notes" in text
            and re.search(r"(?m)^\s*[-*] +Keep all station lists", text)
        ):
            result.lost_formatting.append(probe.title)
    return result
