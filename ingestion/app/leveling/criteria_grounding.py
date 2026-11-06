"""Deterministic value checks for SURVEY acceptance-criteria proposals (see app.leveling.acceptance_criteria).

Two jobs, both pure code and independent of any model or document layout:

- `has_quantity` says whether a requirement's own text already carries a checkable value (a number with a unit, a comparator with a number),
  a cited standard or a verification phrase. Such a requirement verifies itself, so it is not asked about; a bare count ("4 channels"), a
  section reference ("see 4.2.1") or a version ("2.0") is not a checkable value.
- `given_values` / `ungrounded` check a proposed criterion against the text the model was given: every number, unit attached to a number,
  standard and dotted section reference in the criterion must also stand in that text, else it is reported (the caller drops the criterion:
  a value the input does not state is an invented value). Numbers compare by value ("5.0" = "5", "1,000" = "1000", "five" = "5", a Hebrew
  number word counts), signs are ignored ("-40 to +85" is the numbers 40 and 85) and a standard compares without spaces and hyphens.

Known limits, accepted: a unit conversion (1 km in the input, 1000 m in the criterion) reads as invented; a number word prefixed in Hebrew
("בשלוש") is not recognised; "one" is never read as a number (it is mostly a pronoun)."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

_DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−־"), "-")
_BIDI = dict.fromkeys(map(ord, "‎‏‪‫‬‭‮⁦⁧⁨⁩"), None)
_THOUSANDS = re.compile(r"(?<=\d)[,   ](?=\d{3}(?!\d))")

_WORD_NUMBERS = {
    "zero": 0,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thousand": 1000,
    "million": 1000000,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
    "hundred": 100,
    "שתיים": 2,
    "שתי": 2,
    "שני": 2,
    "שניים": 2,
    "שלוש": 3,
    "שלושה": 3,
    "ארבע": 4,
    "ארבעה": 4,
    "חמש": 5,
    "חמישה": 5,
    "שש": 6,
    "שישה": 6,
    "שבע": 7,
    "שבעה": 7,
    "שמונה": 8,
    "תשע": 9,
    "תשעה": 9,
    "עשר": 10,
    "עשרה": 10,
}
_WORD_NUMBER = re.compile(
    r"(?<![\w])("
    + "|".join(sorted(map(re.escape, _WORD_NUMBERS), key=len, reverse=True))
    + r")(?![\w])",
    re.IGNORECASE,
)

# A standard: an upper-case designator, then more designators or a number ("MIL-STD-810G", "RS-422", "DO-178C", "ISO 9001", "IEEE 802.3").
_STANDARD = re.compile(
    r"(?<![\w-])[A-Z]{2,}(?:[ -][A-Z]{2,}){0,6}[ -]?\d[0-9A-Za-z]*(?:\.\d+[0-9A-Za-z]*)*"
)
_SECTION_REF = re.compile(r"(?<![\w.])\d+(?:\.\d+){2,}(?![\w.]*\d)")
_NUMBER = re.compile(r"(?<![\d.])\d+(?:\.\d+)?")
# A unit counts only when attached to a number. Single-letter units are case-sensitive, so "3 a time" has none.
_UNIT_WORDS = (
    "milliseconds?|seconds?|minutes?|hours?|days?|msec|sec|min|hr|khz|mhz|ghz|hz|hertz|kbps|mbps|gbps|bps|dbm|db|decibels?|rpm|psi|kpa|pa|"
    "pascals?|bar|lux|ohms?|kv|mv|ma|mw|kw|kn|kg|mg|mm|cm|km|kb|mb|gb|tb|ms|µs|μs|us|ns|°c|°f|watts?|volts?|amps?|amperes?|"
    "(?:milli|centi|kilo)?(?:meters?|metres?|grams?)|newtons?|joules?|kelvin|celsius|fahrenheit|degrees?|bytes?|percent|inch(?:es)?|feet|foot|"
    "miles?|pounds?|(?:milli)?liters?|(?:milli)?litres?"
)
_UNIT = re.compile(
    rf"(?<=\d)(?:\s?(?:%|(?i:{_UNIT_WORDS})(?![A-Za-z])|[AVWNsmghΩ](?![A-Za-z]))|-(?i:{_UNIT_WORDS})(?![A-Za-z]))"
)
# "one" is read as a number only when a unit follows ("one-meter drop", "one second"): elsewhere it is mostly a pronoun.
_ONE_BEFORE_UNIT = re.compile(
    rf"(?<![\w])one(?=[\s-]+(?i:{_UNIT_WORDS})(?![A-Za-z]))", re.IGNORECASE
)
_UNIT_CANON = {
    "millisecond": "ms",
    "milliseconds": "ms",
    "msec": "ms",
    "second": "s",
    "seconds": "s",
    "sec": "s",
    "minute": "min",
    "minutes": "min",
    "hour": "h",
    "hours": "h",
    "hr": "h",
    "ohm": "Ω",
    "ohms": "Ω",
    "μs": "µs",
    "us": "µs",
    "watt": "w",
    "watts": "w",
    "volt": "v",
    "volts": "v",
    "amp": "a",
    "amps": "a",
    "ampere": "a",
    "amperes": "a",
    "meter": "m",
    "meters": "m",
    "metre": "m",
    "metres": "m",
    "gram": "g",
    "grams": "g",
    "newton": "n",
    "newtons": "n",
    "hertz": "hz",
    "decibel": "db",
    "decibels": "db",
    "pascal": "pa",
    "pascals": "pa",
    "degree": "°",
    "degrees": "°",
    "percent": "%",
    "byte": "b",
    "bytes": "b",
    "kilogram": "kg",
    "kilograms": "kg",
    "kilometer": "km",
    "kilometers": "km",
    "millimeter": "mm",
    "millimeters": "mm",
    "centimeter": "cm",
    "centimeters": "cm",
}
# "Step 1:", "(2)", "3. ": a separator must be followed by a space, or "99.9% ..." would lose its "99."
_ENUMERATOR = re.compile(r"^\s*(?:step\s*)?\(?\d{1,3}(?:[.:]\s+|\)\s*)", re.IGNORECASE)
# A requirement's own id at the start of its text ("SRS-045 The system shall ...", "REQ-12: ...") is not a cited standard.
_LEADING_ID = re.compile(r"^\s*[A-Z]{2,}[-_ ]?\d+(?:[.-]\d+)*\s*[:.)-]?\s+")

_COMPARATOR_NUMBER = re.compile(
    r"(?:<=|>=|≤|≥|[<>]|at least|at most|no more than|no less than|not exceed(?:ing)?|less than|more than|greater than|within|up to|"
    r"minimum(?: of)?|maximum(?: of)?|לפחות|לכל היותר|עד|תוך|פחות מ|יותר מ)\s*[-+]?\d",
    re.IGNORECASE,
)
# How a requirement says it is verified. Only phrases: a bare "measured" or "analysis" is often a content word ("the measured temperature").
_VERIFICATION = re.compile(
    r"\b(?:be|is|are) (?:verified|tested|demonstrated|inspected|analy[sz]ed|validated|measured)\b"
    r"|\b(?:verified|tested|measured|validated|demonstrated|inspected|analy[sz]ed) (?:by|per|using|through|in accordance|against|according)\b"
    r"|\bverification\b|\btest procedure\b|\bby (?:test|inspection|analysis|demonstration)\b"
    r"|יאומת|ייבדק|יבדק|נבדק|תיבדק|מאומת|בבדיקה|בהדגמה|באנליזה|בניתוח",
    re.IGNORECASE,
)
_MIN_STANDARD_DIGITS = 3  # "RS-422", "ISO 9001", "DO-178C" cite a standard; "UART 2" or "CAN 2.0B" name a port or a bus


def _cites_standard(text: str) -> bool:
    return any(
        sum(c.isdigit() for c in m.group()) >= _MIN_STANDARD_DIGITS
        for m in _STANDARD.finditer(text)
    )


@dataclass(frozen=True)
class Grounding:
    """The values stated in a body of text (see `given_values`)."""

    numbers: frozenset[str] = frozenset()
    units: frozenset[str] = frozenset()
    standards: frozenset[str] = frozenset()
    refs: frozenset[str] = frozenset()


def _normalise(text: str) -> str:
    text = (
        unicodedata.normalize("NFKC", _THOUSANDS.sub("", text or ""))
        .translate(_BIDI)
        .translate(_DASHES)
    )  # before NFKC, which turns the thin spaces into plain ones
    text = _WORD_NUMBER.sub(lambda m: str(_WORD_NUMBERS[m.group(1).casefold()]), text)
    return _ONE_BEFORE_UNIT.sub("1", text)


def _number_key(raw: str) -> str:
    try:
        return format(Decimal(raw).normalize(), "f")
    except (
        InvalidOperation
    ):  # unreachable for the number pattern; a value that cannot be read never matches anything
        return raw


def _standard_key(raw: str) -> str:
    return re.sub(r"[ -]", "", raw).casefold()


def _unit_key(raw: str) -> str:
    unit = raw.strip(" -").casefold()
    return _UNIT_CANON.get(unit, unit)


def _values(text: str, standard_digits_count: bool) -> Grounding:
    """`standard_digits_count`: the digits of a standard also count as numbers (for the given text: "810" may be quoted from MIL-STD-810G);
    in a criterion they belong to the standard, which is checked as a whole."""
    text = _normalise(text)
    standards = {_standard_key(m.group()) for m in _STANDARD.finditer(text)}
    numbers = (
        {_number_key(n) for m in _STANDARD.finditer(text) for n in _NUMBER.findall(m.group())}
        if standard_digits_count
        else set()
    )
    text = _STANDARD.sub(" ", text)
    refs = {m.group() for m in _SECTION_REF.finditer(text)}
    text = _SECTION_REF.sub(" ", text)
    units = {_unit_key(m.group()) for m in _UNIT.finditer(text)}
    numbers |= {_number_key(n) for n in _NUMBER.findall(text)}
    return Grounding(frozenset(numbers), frozenset(units), frozenset(standards), frozenset(refs))


def given_values(texts: Iterable[str]) -> Grounding:
    """The values stated across `texts`: everything the model was given that may ground a criterion."""
    merged = Grounding()
    for text in texts:
        found = _values(text, True)
        merged = Grounding(
            merged.numbers | found.numbers,
            merged.units | found.units,
            merged.standards | found.standards,
            merged.refs | found.refs,
        )
    return merged


def ungrounded(criterion: str, given: Grounding) -> list[str]:
    """The values in `criterion` that the input does not state, as short labels ("number:7"); empty when every value is grounded. A list
    enumerator at the start ("Step 1:", "(2)", "3.") is not a value."""
    found = _values(_ENUMERATOR.sub("", criterion, count=1), False)
    return (
        [f"number:{n}" for n in sorted(found.numbers - given.numbers)]
        + [f"unit:{u}" for u in sorted(found.units - given.units)]
        + [f"standard:{s}" for s in sorted(found.standards - given.standards)]
        + [f"ref:{r}" for r in sorted(found.refs - given.refs)]
    )


def has_quantity(text: str) -> bool:
    """True when `text` states a checkable value (number with a unit, comparator with a number), cites a standard, or says how it is
    verified. A bare count, a section reference or a version is not one."""
    text = _LEADING_ID.sub("", _normalise(text), count=1)
    return bool(
        _cites_standard(text)
        or _VERIFICATION.search(text)
        or _COMPARATOR_NUMBER.search(text)
        or _UNIT.search(_SECTION_REF.sub(" ", text))
    )
