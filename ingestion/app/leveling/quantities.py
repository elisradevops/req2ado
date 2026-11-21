"""Quantities stated in a requirement's text, normalised so two statements can be compared by value (see app.leveling.conflict_detection).

A quantity is a number with a unit attached ("85%", "28 VDC", "-40 to +85 °C" is two). Units convert only where the factor is exact and
unambiguous: SI prefixes, minutes and hours, Celsius to kelvin. Everything else (imperial units, data sizes, decibels) compares only with
itself, so a rounded conversion in the source ("14.7 psi (101.3 kPa)") is never read as a disagreement. A bare number is not a quantity:
counts, ids and versions carry no unit. Text normalisation (dashes, bidi marks, thousands separators, number words) and the unit
vocabulary are criteria_grounding's, so both checks read a value the same way; units written as Hebrew words ("28 וולט", "תוך 2 שניות")
are read here too.

`compare` answers for two statements: "agree" when, in every dimension both state, each side's values are covered by the other's (one may
state more values than the other), "differ" when each side states a value the other does not, and "incomparable" when they share no
dimension, so code cannot decide and the caller must ask."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Literal

from app.leveling.criteria_grounding import (
    _SECTION_REF,
    _STANDARD,
    _UNIT_CANON,
    _UNIT_WORDS,
    _normalise,
)

# Units written as Hebrew words, mapped to the canonical unit they name. Longest first in the pattern, so "מילישניות" is not read as "שניות".
_HEBREW_UNITS = {
    "מעלות צלזיוס": "°c",
    "מילישניות": "ms",
    "מילישנייה": "ms",
    "שניות": "s",
    "שנייה": "s",
    "שניה": "s",
    "דקות": "min",
    "דקה": "min",
    "שעות": "h",
    "שעה": "h",
    "וולט": "v",
    "וואט": "w",
    "ואט": "w",
    "אמפר": "a",
    "הרץ": "hz",
    "קילוהרץ": "khz",
    "מגהרץ": "mhz",
    "מילימטר": "mm",
    "סנטימטר": "cm",
    "קילומטר": "km",
    "מטרים": "m",
    "מטר": "m",
    "קילוגרם": "kg",
    "גרם": "g",
    "אחוזים": "%",
    "אחוז": "%",
}
_HEBREW_UNIT = "|".join(sorted(map(re.escape, _HEBREW_UNITS), key=len, reverse=True))

# A number, optionally signed, optionally the start of a range ("-40 to +85", "10-20", "5 עד 10"); then its unit and, for electrical
# units, AC or DC. A sign counts only after a space, a bracket or the start, so "x-5 V" has no quantity at all; a Hebrew one-letter
# prefix joined by a hyphen ("ב-5 שניות", "מ-28V") is not a sign.
_QUANTITY = re.compile(
    r"(?:(?<=[בלמכהוש]-)|(?<![\w.+±-]))(?P<pm>±\s?)?(?P<a>[-+]?\d+(?:\.\d+)?)"
    r"(?:\s*(?:to|-|~|עד)\s*(?P<b>[-+]?\d+(?:\.\d+)?))?"
    r"\s?(?:(?P<unit>%|°\s?[CF]|(?i:degrees?\s+(?:celsius|centigrade|fahrenheit))|"
    rf"(?i:{_UNIT_WORDS})|[AVWNsmghΩ])"
    r"(?:\s?(?P<kind>[AaDd][Cc]))?(?![A-Za-z])"
    rf"|(?P<hebrew>{_HEBREW_UNIT})(?![\u0590-\u05FF]))"
)

# unit -> (dimension, factor to the dimension's base unit, offset). Only exact conversions share a dimension.
_DECIMAL_UNITS: dict[str, tuple[str, str]] = {
    "ns": ("time", "0.000000001"),
    "µs": ("time", "0.000001"),
    "ms": ("time", "0.001"),
    "s": ("time", "1"),
    "min": ("time", "60"),
    "h": ("time", "3600"),
    "hz": ("frequency", "1"),
    "khz": ("frequency", "1000"),
    "mhz": ("frequency", "1000000"),
    "ghz": ("frequency", "1000000000"),
    "mv": ("voltage", "0.001"),
    "v": ("voltage", "1"),
    "kv": ("voltage", "1000"),
    "ma": ("current", "0.001"),
    "a": ("current", "1"),
    "mw": ("power", "0.001"),
    "w": ("power", "1"),
    "kw": ("power", "1000"),
    "mm": ("length", "0.001"),
    "cm": ("length", "0.01"),
    "m": ("length", "1"),
    "km": ("length", "1000"),
    "milligram": ("mass", "0.000001"),
    "milligrams": ("mass", "0.000001"),
    "mg": ("mass", "0.000001"),
    "g": ("mass", "0.001"),
    "kg": ("mass", "1"),
    "n": ("force", "1"),
    "kn": ("force", "1000"),
    "pa": ("pressure", "1"),
    "kpa": ("pressure", "1000"),
    "bar": ("pressure", "100000"),
    "bps": ("data rate", "1"),
    "kbps": ("data rate", "1000"),
    "mbps": ("data rate", "1000000"),
    "gbps": ("data rate", "1000000000"),
    "%": ("percent", "1"),
}
_CELSIUS = Fraction("273.15")
# Data sizes keep their case: "MB" (megabyte) and "Mb" (megabit) are different units, and 1000 vs 1024 is ambiguous, so none converts.
_CASED_UNITS = {"b", "kb", "mb", "gb", "tb"}


@dataclass(frozen=True)
class Quantity:
    dimension: str
    value: Fraction  # in the dimension's base unit
    kind: str = ""  # "ac" / "dc" when stated
    tolerance: bool = False  # "±5 V" is a tolerance, not a level
    raw: str = field(default="", compare=False)  # as the text states it


def _unit(raw: str) -> tuple[str, Fraction, Fraction]:
    unit = re.sub(r"\s+", " ", raw.strip())
    unit = _HEBREW_UNITS.get(unit, unit)
    folded = unit.casefold()
    if (
        folded.startswith("°")
        or "celsius" in folded
        or "centigrade" in folded
        or "fahrenheit" in folded
    ):
        if folded.endswith("f") or "fahrenheit" in folded:
            return "temperature °F", Fraction(1), Fraction(0)
        return "temperature", Fraction(1), _CELSIUS
    canon = _UNIT_CANON.get(folded, folded)
    if canon in {"kelvin"}:
        return "temperature", Fraction(1), Fraction(0)
    if canon in _CASED_UNITS:
        return f"data {unit}", Fraction(1), Fraction(0)
    if canon in _DECIMAL_UNITS:
        dimension, factor = _DECIMAL_UNITS[canon]
        return dimension, Fraction(factor), Fraction(0)
    return canon, Fraction(1), Fraction(0)


def quantities(text: str) -> list[Quantity]:
    """Every quantity `text` states, in order. Standards ("MIL-STD-810G") and dotted section references are not quantities."""
    text = _SECTION_REF.sub(" ", _STANDARD.sub(" ", _normalise(text)))
    found: list[Quantity] = []
    for match in _QUANTITY.finditer(text):
        dimension, factor, offset = _unit(match.group("unit") or match.group("hebrew"))
        kind = (match.group("kind") or "").casefold()
        tolerance = match.group("pm") is not None
        raw = match.group().strip()
        for number in (match.group("a"), match.group("b")):
            if number is not None:
                found.append(
                    Quantity(dimension, Fraction(number) * factor + offset, kind, tolerance, raw)
                )
    return found


Agreement = Literal["agree", "differ", "incomparable"]


@dataclass(frozen=True)
class Comparison:
    status: Agreement
    differing: tuple[
        str, ...
    ] = ()  # the values, as each text states them, that the other text does not


def _covered(item: Quantity, others: list[Quantity]) -> bool:
    return any(
        other.dimension == item.dimension
        and other.value == item.value
        and other.tolerance == item.tolerance
        and (other.kind == item.kind or not other.kind or not item.kind)
        for other in others
    )


def compare(text_a: str, text_b: str) -> Comparison:
    """Do two statements agree on the values they both state? See the module docstring."""
    a, b = quantities(text_a), quantities(text_b)
    shared = {q.dimension for q in a} & {q.dimension for q in b}
    if not shared:
        return Comparison("incomparable")
    a = [q for q in a if q.dimension in shared]
    b = [q for q in b if q.dimension in shared]
    only_a = [q for q in a if not _covered(q, b)]
    only_b = [q for q in b if not _covered(q, a)]
    if only_a and only_b:
        return Comparison("differ", tuple(dict.fromkeys(q.raw for q in only_a + only_b)))
    return Comparison("agree")
