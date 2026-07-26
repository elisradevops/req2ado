from __future__ import annotations

import re

_NUMBERING_PATTERN = re.compile(r"^(\d+(?:\.\d+)*(?:\.[a-z])?)\.?\s+(.*)$", re.DOTALL)


def parse_numbering(text: str) -> tuple[str | None, str]:
    """Detects a leading numbering label like '1', '1.1', '1.1.1.1', or
    '1.1.1.a' at the start of the text and returns (label, remainder-with-
    label-stripped). Returns (None, text) if no numbering prefix is found.

    The trailing '.?' before the mandatory whitespace accepts a top-level
    label written with its own closing dot ('1. Receiver', '2. Remote
    Control') -- a real, common numbering convention this previously
    rejected: '1.' was followed by a space, not a digit, so neither
    '(?:\\.\\d+)*' nor '(?:\\.[a-z])?' could consume that dot, and the
    mandatory '\\s+' then failed to match against it. The consequence was
    silent, total data loss for any document using this convention: every
    top-level line resolved to depth=None (see depth.py), and in
    tree_builder.py's main loop a depth=None block with an empty stack (no
    node open yet to fold into) is dropped with no warning at all --
    verified against a synthesized flat-list fixture where this silently
    dropped BOTH top-level branch headers (13 source blocks -> 11 nodes).
    Still anchored at the start of the (stripped) text and still requires
    real whitespace after the optional dot, so 'e.g. text' and a decimal
    like '3.3V shall...' (no whitespace immediately after the dot) remain
    correctly unmatched, same as before this fix."""
    match = _NUMBERING_PATTERN.match(text.strip())
    if not match:
        return None, text
    label, remainder = match.group(1), match.group(2)
    return label, remainder


def numbering_depth(label: str) -> int:
    return len(label.split("."))
