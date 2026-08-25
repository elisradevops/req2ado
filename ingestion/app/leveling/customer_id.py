"""Generic, format-agnostic extraction of a customer-assigned requirement
code (e.g. "REQ-AV-014", "SR12345", "ABC-1234") from a block/row's own raw
text -- the customer's OWN requirement identifier, as distinct from the
document's internal dotted heading/numbering structure (see
depth.authored_numbering_label), which is a separate, purely structural
concept this module knows nothing about. Customer ID resolution tries this
FIRST (a customer-assigned code is the more authentic "Customer ID" signal)
and falls back to the document's own dotted numbering only when no such
code is found -- see tree_builder.py's/id_tree_builder.py's own call sites.

Deliberately generic -- no single customer's exact convention is
hardcoded, since different source documents use different schemes.
Matches a short (2-8 letter) uppercase prefix, optionally segmented by '-'
or '_' (e.g. the "AV" in "REQ-AV-014"), ending in 2-8 digits. Requires an
uppercase-letter prefix specifically so it does not accidentally match
ordinary technical prose containing units/measurements -- "3.3V", "50ms",
"2-18 GHz", and "10ms" all either start with a digit or never reach 2+
consecutive uppercase letters immediately before their own digits, so none
of them qualify (verified directly against exactly these strings, all of
which appear in this codebase's own real ingestion test fixtures)."""
from __future__ import annotations

import re

_CUSTOMER_CODE_PATTERN = re.compile(r"\b[A-Z]{2,8}(?:[-_][A-Z0-9]{1,8})*[-_]?\d{2,8}\b")


def extract_customer_requirement_code(text: str) -> str | None:
    """Returns the first customer-assigned requirement code found anywhere
    in `text`, or None if none is found. Never fabricates -- an absent
    match is a real, honest None, not a fallback to guessing."""
    match = _CUSTOMER_CODE_PATTERN.search(text)
    return match.group(0) if match else None
