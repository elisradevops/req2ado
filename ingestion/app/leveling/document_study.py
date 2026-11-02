"""A first, extractive reading of the whole document, before any acceptance-criteria work.

How a document marks an unresolved value (TBD, ??, N, XYZ), how it states verification, what its glossary, standards and tables are, varies
from one document to the next, so the model reads the document once and reports only what the text itself states. Every entry is checked
against the window it came from and dropped when the text does not contain it, so a model answer can never put words in the document's mouth.

Pattern of app.kb.profile (overlapping windows, strict JSON, malformed entries dropped), built for the job's document instead of a KB
document. A window that fails is skipped; when none succeed the result is None and the caller carries on with the hierarchy alone."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Protocol

from app.kb.profile import windows_of

logger = logging.getLogger(__name__)

# The study reads the document in windows of its own size (same shape as the KB profile's, tuned separately).
STUDY_WINDOW_CHARS = 10_000
STUDY_WINDOW_OVERLAP = 500
# A document longer than this many windows is studied only up to the cap (the study is context for a few items, not coverage).
MAX_STUDY_WINDOWS = 30
_MAX_QUOTE_CHARS = 300
_MAX_TOKEN_CHARS = 20


class DocumentStudyClient(Protocol):
    def study_document_window(self, window_text: str, user_id: str | None = None) -> dict: ...


@dataclass
class DocumentStudy:
    glossary: list[dict] = field(default_factory=list)  # {term, definition}
    placeholder_tokens: list[str] = field(default_factory=list)
    verification_statements: list[str] = field(default_factory=list)
    standards_cited: list[str] = field(default_factory=list)
    table_roles: list[dict] = field(default_factory=list)  # {table, role}
    lead_in_patterns: list[str] = field(default_factory=list)
    windows_studied: int = 0
    windows_total: int = 0


def _squash(text: str) -> str:
    return " ".join(text.split()).casefold()


def _strings(raw: object, window: str, max_chars: int) -> list[str]:
    """The non-empty strings of `raw` that the window text really contains."""
    if not isinstance(raw, list):
        return []
    squashed = _squash(window)
    return [
        item.strip() for item in raw
        if isinstance(item, str) and item.strip() and len(item.strip()) <= max_chars and _squash(item) in squashed
    ]


def _objects(raw: object, *fields: str) -> list[dict]:
    if not isinstance(raw, list):
        return []
    return [
        {f: item[f].strip() for f in fields}
        for item in raw
        if isinstance(item, dict) and all(isinstance(item.get(f), str) and item[f].strip() for f in fields)
    ]


def _merge(into: list, items: list) -> None:
    for item in items:
        if item not in into:
            into.append(item)


def _window_findings(answer: object, window: str) -> DocumentStudy:
    found = DocumentStudy()
    if not isinstance(answer, dict):
        return found
    squashed = _squash(window)
    found.glossary = [g for g in _objects(answer.get("glossary"), "term", "definition") if _squash(g["term"]) in squashed]
    # A marker must stand alone in the window exactly as returned (case included): a letter that merely occurs somewhere, or a lowercase
    # variant of "TBD", is not the document's marker.
    found.placeholder_tokens = [
        t for t in _strings(answer.get("placeholder_tokens"), window, _MAX_TOKEN_CHARS) if contains_token(window, t)
    ]
    found.verification_statements = _strings(answer.get("verification_statements"), window, _MAX_QUOTE_CHARS)
    found.standards_cited = _strings(answer.get("standards_cited"), window, _MAX_QUOTE_CHARS)
    found.table_roles = [r for r in _objects(answer.get("table_roles"), "table", "role") if f"[TABLE {r['table']}]" in window]
    found.lead_in_patterns = _strings(answer.get("lead_in_patterns"), window, _MAX_QUOTE_CHARS)
    return found


def study_document(document_text: str, client: DocumentStudyClient, user_id: str | None = None) -> DocumentStudy | None:
    if not document_text.strip():
        return None
    windows = windows_of(document_text, STUDY_WINDOW_CHARS, STUDY_WINDOW_OVERLAP)
    study = DocumentStudy(windows_total=len(windows))
    for window in windows[:MAX_STUDY_WINDOWS]:
        try:
            answer = client.study_document_window(window, user_id=user_id)
        except Exception as error:  # noqa: BLE001 -- best-effort context: the caller degrades to the hierarchy alone
            logger.warning("Document study: a window could not be read (%s); skipping it.", error)
            continue
        study.windows_studied += 1
        found = _window_findings(answer, window)
        _merge(study.glossary, found.glossary)
        _merge(study.placeholder_tokens, found.placeholder_tokens)
        _merge(study.verification_statements, found.verification_statements)
        _merge(study.standards_cited, found.standards_cited)
        _merge(study.table_roles, found.table_roles)
        _merge(study.lead_in_patterns, found.lead_in_patterns)
    return study if study.windows_studied else None


def contains_token(text: str, token: str) -> bool:
    """True when `token` stands alone in `text`, case-sensitive: the document's own marker, as written. Never inside a longer word and
    never joined to a neighbour by "/" or "+" ("Y/N", "N+1"). Short alphabetic markers ("N", "X", "XX") are also ignored right after a
    number ("50 N" is a unit) and when part of a name or assignment ("X-ray", "N-1", "N=5"); "TBD", "??" and the like are not."""
    escaped = re.escape(token)
    before, after = r"(?<![\w/+])", r"(?![\w/+])"
    if token.isalpha() and len(token) <= 2:
        before += r"(?<!\d)(?<!\d )(?<!\w-)(?<!\w\.)"
        after += r"(?!-\w)(?!\.\w)(?!=)"
    elif not any(c.isalnum() for c in token):
        # "what??" is prose, "10??" is a number left unresolved: only a letter in front rules it out.
        before = r"(?<![A-Za-z/+])(?<!" + re.escape(token[0]) + ")"
        after += "(?!" + re.escape(token[-1]) + ")"
    return re.search(f"{before}{escaped}{after}", text) is not None
