"""Requirement scores computed in code from the model's anchored judgments (S3 of the prompt root-cause work).

The model answers only what needs language judgment: for each category a level on a fixed 0-4 scale (the anchors are in the scoring prompt)
with a short evidence quote, and a closed list of findings, each with the quote it concerns. Everything else is decided here, the same way
for every model:

- a level becomes a 0-100 category score (level / MAX_LEVEL, so 0, 25, 50, 75, 100; the mean of two votes can fall between);
- the overall score is the mean of the quality categories, gated by completeness_as_requirement (a statement that is not a requirement
  scores low however well it reads);
- the issues are the findings whose quote the item's text really contains, plus the issues the levels themselves state (LEVEL_ISSUES);
- the confidence is how far two independent votes agree, never the model's opinion of itself.

The result has the shape the scoring code has always read ({"score", "issues", "categoryScores", "confidence"}), so nothing after the
client changes."""

from __future__ import annotations

from collections.abc import Sequence

COMPLETENESS = "completeness_as_requirement"
BUILTIN_CATEGORIES = ("clarity", "testability", "atomicity", "style", "rationale")
MAX_LEVEL = 4

# The issues a low level states by itself (the category's anchors in the prompt say so): a built-in category at or below the level, and
# completeness always. A category the organization named has no fixed meaning to code, so its levels state no issue; its findings do.
LEVEL_ISSUES: dict[str, tuple[tuple[int, str], ...]] = {
    COMPLETENESS: ((0, "not_a_requirement"), (1, "fragment")),
    "clarity": ((1, "ambiguous"),),
    "testability": ((1, "not_testable"), (2, "missing_acceptance_criteria")),
    "atomicity": ((1, "compound"),),
    "style": ((1, "passive_voice"),),
    "rationale": ((1, "missing_rationale"),),
}
# The findings the model may report. conflicting_value is not one: duplicate detection sets it from two items, never one.
FINDINGS = (
    "ambiguous",
    "not_testable",
    "compound",
    "missing_acceptance_criteria",
    "vague_term",
    "passive_voice",
    "missing_rationale",
    "not_a_requirement",
    "fragment",
    "placeholder",
    "open_item_tbd",
    "rationale_as_requirement",
)
# Two votes whose levels for one category differ by this much (or that disagree on whether the item is a requirement at all) are a
# low-confidence score; a difference of at most AGREE_WITHIN everywhere, with the same issues, is a high one.
AGREE_WITHIN = 1
DISAGREE_FROM = 3


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def levels_of(answer: object) -> dict[str, int]:
    """name -> level of one vote's answer for one item; an entry without a name or with a level outside 0..MAX_LEVEL is left out (a
    bool is not a level). The first entry of a name wins."""
    levels: dict[str, int] = {}
    categories = answer.get("categories") if isinstance(answer, dict) else None
    for entry in categories if isinstance(categories, list) else []:
        if not isinstance(entry, dict):
            continue
        name, level = entry.get("name"), entry.get("level")
        if (
            isinstance(name, str)
            and name.strip()
            and isinstance(level, int)
            and not isinstance(level, bool)
            and 0 <= level <= MAX_LEVEL
        ):
            levels.setdefault(name.strip(), level)
    return levels


def findings_of(answer: object, text: str) -> set[str]:
    """The findings of one vote whose quote the item's text contains (whitespace and case aside). A finding without a real quote is
    dropped: the model must point at the words it judged."""
    found: set[str] = set()
    findings = answer.get("findings") if isinstance(answer, dict) else None
    squashed = _squash(text)
    for entry in findings if isinstance(findings, list) else []:
        if not isinstance(entry, dict) or entry.get("issue") not in FINDINGS:
            continue
        quote = entry.get("quote")
        if isinstance(quote, str) and quote.strip() and _squash(quote) in squashed:
            found.add(entry["issue"])
    return found


def _level_issues(levels: dict[str, float]) -> set[str]:
    issues: set[str] = set()
    for name, level in levels.items():
        for at_most, issue in LEVEL_ISSUES.get(name, ()):
            if level <= at_most:
                issues.add(issue)
                break
    return issues


def _score(level: float) -> float:
    return level * 100 / MAX_LEVEL


def _overall(levels: dict[str, float]) -> int:
    quality = [_score(level) for name, level in levels.items() if name != COMPLETENESS]
    completeness = levels.get(COMPLETENESS)
    if not quality:
        return round(_score(completeness or 0))
    gate = 1.0 if completeness is None else completeness / MAX_LEVEL
    return round(sum(quality) / len(quality) * gate)


def _confidence(votes: Sequence[dict[str, int]], issue_sets: Sequence[set[str]]) -> str:
    if len(votes) < 2:
        return "medium"  # one vote: agreement could not be measured
    first, second = votes[0], votes[1]
    shared = first.keys() & second.keys()
    gap = max((abs(first[n] - second[n]) for n in shared), default=0)
    split = COMPLETENESS in shared and min(first[COMPLETENESS], second[COMPLETENESS]) <= 1 < max(
        first[COMPLETENESS], second[COMPLETENESS]
    )
    if gap >= DISAGREE_FROM or split:
        return "low"
    if gap <= AGREE_WITHIN and issue_sets[0] == issue_sets[1]:
        return "high"
    return "medium"


def entry_from_votes(answers: Sequence[object], text: str) -> dict | None:
    """One item's score entry from its votes' answers (a missing or unusable answer is skipped). None when no vote judged any category.
    Category levels are the mean of the votes that judged that category; categories only one vote named are kept (the key check in
    app.leveling.scoring decides what a missing one means)."""
    votes = [levels for levels in (levels_of(a) for a in answers) if levels]
    if not votes:
        return None
    usable = [a for a in answers if levels_of(a)]
    issue_sets = [findings_of(a, text) for a in usable]
    names = list(dict.fromkeys(name for levels in votes for name in levels))
    mean_levels = {
        name: sum(v[name] for v in votes if name in v) / sum(1 for v in votes if name in v)
        for name in names
    }
    issues = set().union(*issue_sets) | _level_issues(mean_levels)
    return {
        "score": _overall(mean_levels),
        "issues": sorted(issues),
        "categoryScores": {name: round(_score(level)) for name, level in mean_levels.items()},
        "confidence": _confidence(votes, issue_sets),
    }
