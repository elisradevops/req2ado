"""Which categories to explain for an item, what each is held to, and on what basis the explanation is made.

The basis is the rubric the item was graded against: the organization's own pass conditions when there is a knowledge base, otherwise the
built-in rubric together with its design philosophy (what an Epic, a Feature and a Requirement are, and what makes a requirement good). Pins
and removals the user made are already part of that rubric."""
from __future__ import annotations

from app.kb.default_rubric import DESIGN_PHILOSOPHY
from app.kb.profile import KbProfile, _key

WEAK_SCORE = 70
MAX_EXPLAINED = 5
MAX_REQUESTED = 8
_COMPLETENESS = (
    "completeness_as_requirement",
    "Is a complete requirement statement (a subject, 'shall', and a verifiable predicate), not a bare label, value or table cell.",
    "Turn it into a full statement, or drop it if it is only a label, a value or a cell.",
)


def choose_categories(scores: dict | None, requested: list[str] | None) -> list[str]:
    """The categories asked about, else the weakest (below the bar, at most five, weakest first); an item with none below the bar still gets
    its two lowest explained."""
    if requested:
        seen: dict[str, str] = {}
        for name in requested:
            if isinstance(name, str) and name.strip():
                seen.setdefault(_key(name), name.strip())
        return list(seen.values())[:MAX_REQUESTED]
    usable = sorted(
        ((name, float(value)) for name, value in (scores or {}).items() if isinstance(name, str) and isinstance(value, (int, float)) and not isinstance(value, bool)),
        key=lambda pair: (pair[1], pair[0]),
    )
    weak = [name for name, value in usable if value < WEAK_SCORE][:MAX_EXPLAINED]
    return weak or [name for name, _ in usable[:2]]


def describe_categories(rubric: KbProfile | None, names: list[str], scores: dict | None) -> list[dict]:
    """For each name: its score, what the rubric holds it to (None when the rubric does not know it, for example a category of an older
    rubric) and how to improve it (only the built-in rubric states that)."""
    by_wording: dict[str, tuple[str | None, str | None]] = {}
    for category in rubric.categories if rubric else []:
        for wording in {_key(category.name), *(_key(m) for m in category.merged_from)}:
            by_wording.setdefault(wording, (category.pass_condition, category.guidance))
    by_wording.setdefault(_key(_COMPLETENESS[0]), (_COMPLETENESS[1], _COMPLETENESS[2]))
    described = []
    for name in names:
        condition, guidance = by_wording.get(_key(name), (None, None))
        score = (scores or {}).get(name)
        described.append({"name": name, "score": score if isinstance(score, (int, float)) and not isinstance(score, bool) else None, "pass_condition": condition, "guidance": guidance})
    return described


def basis_for(rubric: KbProfile | None) -> tuple[str, str]:
    """(the paragraph the explanation prompt is given, 'knowledge_base' | 'built_in')."""
    if rubric is None or rubric.source == "default":
        return (
            "These are the categories of the built-in rubric; the organization has no knowledge base. Hold the item to them in the light of this design "
            f"philosophy:\n{DESIGN_PHILOSOPHY}",
            "built_in",
        )
    return (
        "The categories and pass conditions are the organization's own, taken from its knowledge base (and fixed by its users where they pinned them); "
        "hold the item to them as written.",
        "knowledge_base",
    )
