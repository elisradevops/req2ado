from __future__ import annotations

import re

from app.canonical.model import CanonicalDoc

_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),  # email
    re.compile(r"https?://[^\s]+"),  # url
    re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"),  # guid
    re.compile(r"\b[a-zA-Z0-9-]+\.(?:internal|corp|local)\.[a-zA-Z]{2,}\b"),  # hostname
    re.compile(r"\b(?:PN|P/N)-[A-Za-z0-9-]+\b"),  # part number
]


def _redact_text(text: str) -> str:
    redacted = text
    for pattern in _PATTERNS:
        redacted = pattern.sub("<redacted>", redacted)
    return redacted


def redact_canonical_doc(doc: CanonicalDoc, *, trusted_local: bool = False) -> CanonicalDoc:
    if trusted_local:
        return doc.model_copy(deep=True)

    redacted = doc.model_copy(deep=True)
    for block in redacted.blocks:
        block.text = _redact_text(block.text)
    for table in redacted.tables:
        # Redacts cell TEXT only -- every style field (colspan/rowspan/
        # is_header/bold/background_color/text_color/align) is numeric or
        # enum-valued and cannot itself carry PII, so those pass through
        # untouched.
        for row in table.cells:
            for cell in row:
                if cell is not None:
                    cell.text = _redact_text(cell.text)
        # Pre-existing hole, closed here while touching this function: a
        # Table's own caption (xlsx sheet name, csv filename stem) was never
        # redacted despite being just as capable of carrying a sensitive
        # string (a hostname, part number, etc.) as a figure's caption
        # already is below.
        if table.caption:
            table.caption = _redact_text(table.caption)
    for figure in redacted.figures:
        if figure.caption:
            figure.caption = _redact_text(figure.caption)
    return redacted
