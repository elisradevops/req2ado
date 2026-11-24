"""Generic, format-agnostic extraction of a customer-assigned requirement
code (e.g. "REQ-AV-014", "SR12345", "ABC-1234", "P-SENSOR-001#") from a
block/row's own raw text -- the customer's OWN requirement identifier, as
distinct from the document's internal dotted heading/numbering structure
(see depth.authored_numbering_label), which is a separate, purely
structural concept this module knows nothing about. Customer ID resolution
tries this FIRST (a customer-assigned code is the more authentic
"Customer ID" signal) and falls back to the document's own dotted
numbering only when no such code is found -- see tree_builder.py's/
id_tree_builder.py's own call sites.

Deliberately generic -- no single customer's exact convention is
hardcoded, since different source documents use different schemes.
Matches a short (2-8 letter) uppercase core prefix, optionally segmented by
'-' or '_' (e.g. the "AV" in "REQ-AV-014"), ending in 2-8 digits. An
OPTIONAL single-uppercase-letter segment (e.g. the "P" in "P-SENSOR-001")
may immediately precede that core -- a narrow extension, not a lowered
letter-count floor: the 2-8 letter core is still mandatory for a match to
exist at all, so this never turns a bare single-letter+digit token (a part/
model number like "M3", "T500", "A4") into a false positive on its own; it
only ever extends a match that already qualifies on its own merits. A
trailing '#' is included in the match when literally present (some
customer conventions print it as part of the id itself, e.g. this
document's own "#" table column) -- matched as an explicit alternative,
not via the closing \\b, since '#' is a non-word character and a `\\b`
placed after it would fail whenever '#' is itself followed by another
non-word character (whitespace, end of line), which is the common case.

Requires an uppercase-letter prefix specifically so it does not
accidentally match ordinary technical prose containing units/measurements
or part numbers -- "3.3V", "50ms", "2-18 GHz", "10ms", "M3", and "A4" all
either start with a digit, never reach 2+ consecutive uppercase letters
immediately before their own digits, or (for the single-letter cases) have
no adjacent core to extend, so none of them qualify (verified directly
against exactly these strings, all of which appear in this codebase's own
real ingestion test fixtures)."""

from __future__ import annotations

import re

_CUSTOMER_CODE_PATTERN = re.compile(
    r"\b(?:[A-Z][-_])?[A-Z]{2,8}(?:[-_][A-Z0-9]{1,8})*[-_]?\d{2,8}(?:#|\b)"
)


def extract_customer_requirement_code(text: str) -> str | None:
    """Returns the first customer-assigned requirement code found anywhere
    in `text`, or None if none is found. Never fabricates -- an absent
    match is a real, honest None, not a fallback to guessing."""
    match = _CUSTOMER_CODE_PATTERN.search(text)
    return match.group(0) if match else None


# The same code, as the first token of a text, followed by its own separator: "REQ-001: The PDU shall ...", "SRS-12 - The unit ...".
# The separator is required: without it, an ordinary sentence opening with a standard or an interface ("ISO-9001 compliance is
# required", "RS485 and CAN buses ...") or a cover's document number ("PDU-SPEC-0042 Rev 2.0") read as a requirement code.
_LEADING_CODE_PATTERN = re.compile(
    r"^\s*(" + _CUSTOMER_CODE_PATTERN.pattern[2:] + r")\s*(?:[:.)\]]|\s[-\u2013\u2014])\s+(?=\S)"
)
# A requirement sentence: an obligation word in its first words (the code alone is not enough: "RS485: 9600 baud" is a spec cell).
_OBLIGATION_PATTERN = re.compile(r"\b(shall|must|will|should)\b", re.IGNORECASE)


def leading_requirement_code(text: str) -> tuple[str | None, str]:
    """(code, rest) when `text` opens with a customer requirement code and its separator, else (None, text). The code starts a
    requirement; it is not a "Label: value" label, so callers read `rest` as the requirement sentence."""
    match = _LEADING_CODE_PATTERN.match(text)
    if not match:
        return None, text
    return match.group(1), text[match.end():]


def opens_a_requirement(text: str) -> bool:
    """A text that opens with a requirement code and states an obligation: "REQ-001: The PDU shall ...". Stricter than
    leading_requirement_code, for decisions that must not fire on a spec cell ("RS485: 9600 baud") or a numbered notice."""
    code, rest = leading_requirement_code(text)
    return code is not None and bool(_OBLIGATION_PATTERN.search(" ".join(rest.split()[:25])))
