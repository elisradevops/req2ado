"""What can be told about a proposed rewrite from the two texts alone, before the user applies it. No model is involved.

Each warning is {"code", "severity", "detail"}. `high` means content was probably lost or the item became several items
(numbers or identifiers dropped, far longer, more statements); `notice` means something changed that the user may not have
asked for (the title). The caller shows them and asks for confirmation when any is `high`."""
from __future__ import annotations

import html
import re

_MAX_GROWTH = 2.5  # a rewrite longer than this many times the original ...
_MIN_GROWTH_CHARS = 150  # ... and longer by at least this many characters (a short item may grow a little)
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
# Identifiers: tokens that contain a digit and a letter or a separator joining letters and digits (REQ-12, MIL-STD-461G, 3U, ISO/IEC 29148).
_IDENTIFIER = re.compile(r"\b(?=[A-Za-z0-9/_.-]*\d)(?=[A-Za-z0-9/_.-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9/_.-]*[A-Za-z0-9]\b")
_MODAL = re.compile(r"\b(?:shall|must|should)\b", re.IGNORECASE)


_TAG = re.compile(r"<[^>]+>")
_THOUSANDS = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")


def _norm(text: str | None) -> str:
    """Readable text of a description: a requirement can carry an HTML table, whose attributes (widths, colours, spans) are not
    content; entities are decoded and thousands separators removed so 1,000 and 1000 are the same number."""
    plain = html.unescape(_TAG.sub(" ", text or ""))
    return _THOUSANDS.sub("", " ".join(plain.split()))


def _numbers(text: str) -> list[str]:
    """Numbers outside identifiers (the 461 of MIL-STD-461G is reported with its identifier, not twice)."""
    return [n.rstrip(".,") for n in _NUMBER.findall(_IDENTIFIER.sub(" ", text))]


def check_rewrite(
    original_title: str | None, original_description: str | None, proposed_title: str | None, proposed_description: str | None,
) -> list[dict]:
    try:
        original = _norm(original_description)
        proposed = _norm(proposed_description)
        warnings: list[dict] = []
        if original and not proposed:
            warnings.append({"code": "empty_description", "severity": "high", "detail": "the proposal has no description"})
        if proposed_title is not None and _norm(proposed_title).casefold() != _norm(original_title).casefold():
            warnings.append({"code": "title_changed", "severity": "notice", "detail": "the proposal changes the title"})
        if not original or not proposed:
            return warnings
        if len(proposed) > _MAX_GROWTH * len(original) and len(proposed) - len(original) >= _MIN_GROWTH_CHARS:
            warnings.append(
                {"code": "much_longer", "severity": "high", "detail": f"{len(original)} -> {len(proposed)} characters ({len(proposed) / len(original):.1f}x)"}
            )
        if len(_MODAL.findall(proposed)) > max(1, len(_MODAL.findall(original))):
            warnings.append(
                {"code": "more_statements", "severity": "high", "detail": f"{len(_MODAL.findall(original))} -> {len(_MODAL.findall(proposed))} shall/should/must statements"}
            )
        lost_numbers = [n for n in dict.fromkeys(_numbers(original)) if n not in set(_numbers(proposed))]
        if lost_numbers:
            warnings.append({"code": "dropped_numbers", "severity": "high", "detail": ", ".join(lost_numbers)})
        proposed_ids = {i.casefold() for i in _IDENTIFIER.findall(proposed)}
        lost_ids = [i for i in dict.fromkeys(_IDENTIFIER.findall(original)) if i.casefold() not in proposed_ids]
        if lost_ids:
            warnings.append({"code": "dropped_identifiers", "severity": "high", "detail": ", ".join(lost_ids)})
        return warnings
    except Exception:  # noqa: BLE001 -- a check must never break a chat turn
        return []
