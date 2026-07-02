from __future__ import annotations

import re

_NUMBERING_PATTERN = re.compile(r"^(\d+(?:\.\d+)*(?:\.[a-z])?)\s+(.*)$", re.DOTALL)


def parse_numbering(text: str) -> tuple[str | None, str]:
    """Detects a leading numbering label like '1', '1.1', '1.1.1.1', or
    '1.1.1.a' at the start of the text and returns (label, remainder-with-
    label-stripped). Returns (None, text) if no numbering prefix is found."""
    match = _NUMBERING_PATTERN.match(text.strip())
    if not match:
        return None, text
    label, remainder = match.group(1), match.group(2)
    return label, remainder


def numbering_depth(label: str) -> int:
    return len(label.split("."))
