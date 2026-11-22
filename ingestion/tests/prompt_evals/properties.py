"""Checks over a model's answer. Each returns (ok, detail); detail says what was wrong, in a few words, when ok is False."""

from __future__ import annotations

from collections.abc import Iterable

from app.leveling.criteria_grounding import given_values, ungrounded

Check = tuple[bool, str]


def hebrew_ratio(text: str) -> float:
    """The share of letters that are Hebrew."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    return sum("֐" <= c <= "׿" for c in letters) / len(letters)


def all_hebrew(texts: Iterable[str], minimum: float = 0.6) -> Check:
    off = [t[:40] for t in texts if hebrew_ratio(t) < minimum]
    return (not off, f"not Hebrew: {off[:3]}")


def same_ids(answer_ids: Iterable[str], expected: Iterable[str]) -> Check:
    got, want = set(answer_ids), set(expected)
    return (got == want, f"missing {sorted(want - got)} extra {sorted(got - want)}")


def no_invented_values(texts: Iterable[str], source: Iterable[str]) -> Check:
    given = given_values(list(source))
    bad = sorted({label for t in texts for label in ungrounded(t, given)})
    return (not bad, f"invented {bad[:5]}")


def keeps_values(texts: dict[str, str], sources: dict[str, str]) -> Check:
    """Each listed text still states every value of its own source sentence (the code gate's own check, app.leveling.content_authoring)."""
    dropped = sorted(
        f"{key}:{label}"
        for key, source in sources.items()
        for label in ungrounded(source, given_values([texts.get(key, "")]))
    )
    return (not dropped, f"dropped {dropped[:5]}")


def no_emphasis(texts: Iterable[str]) -> Check:
    marked = [t[:40] for t in texts if "**" in t or "__" in t]
    return (not marked, f"emphasis in {marked[:2]}")


def absent(token: str, texts: Iterable[str]) -> Check:
    hits = [t[:40] for t in texts if token.casefold() in t.casefold()]
    return (not hits, f"{token!r} in {hits[:2]}")


def equals(got: object, want: object, what: str) -> Check:
    return (got == want, f"{what} {got!r}, expected {want!r}")


def within(value: object, low: float, high: float, what: str) -> Check:
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high
    return (ok, f"{what} {value!r} outside {low}-{high}")
