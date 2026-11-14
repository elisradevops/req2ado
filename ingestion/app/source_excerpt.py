# ingestion/app/source_excerpt.py
"""The original wording behind a stored SourceRef, for the review dialog's evidence strip.

A work item stores only offsets, and those offsets index the text a loader EXTRACTED (see SourceRef's own docstring for the
per-loader semantics), never the file's bytes. The only faithful way back to the words is to parse the stored original
again with the same loader path the pipeline used (dispatch_by_extension) and read the blocks the span overlaps. Read-only,
no model call, and verbatim: when the span points at nothing real, the answer is "unavailable", never a guess.

- kind "text": the blocks the span overlaps, joined with a blank line.
- kind "table": the span is a table's own ref. All rows of one table share it, so a row_hint (the item's document id) narrows
  the text to the header and the matching rows; without a match the whole table is returned.
- kind "section": extent="section" (a SURVEY item, whose ref is its section's first block shared by every item written from
  that section): from that block to the next heading at the same or a higher level.
- kind "unavailable": an empty span, a span past the end, a figure (its text is a caption or a placeholder, not source
  wording), or a page that does not match.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Literal

from pydantic import BaseModel

from app.canonical.model import Block, BlockKind, CanonicalDoc, SourceRef, Table
from app.dispatch import dispatch_by_extension

MAX_EXCERPT_CHARS = 1500
# A word-boundary cut never throws away more than this share of the cap (one very long "word" is cut where it is).
_MIN_KEEP_RATIO = 0.6
# Loader-synthesized notes ("[UNSUPPORTED: ...]") are the parser talking, not the document.
_SYNTHETIC_NOTE_PREFIX = "[UNSUPPORTED:"
_PARSED_CACHE_MAX = 8

ExcerptKind = Literal["text", "table", "section", "unavailable"]


class SourceExcerpt(BaseModel):
    text: str
    truncated: bool
    kind: ExcerptKind


_UNAVAILABLE = SourceExcerpt(text="", truncated=False, kind="unavailable")

# Re-parsing a document per opened item would cost one full parse (OCR, for a scanned PDF) per J/K step. The parsed document is
# kept by content digest, bounded, so stepping through one job's items parses its file once. A parse that outlives the
# caller's timeout still lands here, so the next open is fast.
_parsed_cache: OrderedDict[str, CanonicalDoc] = OrderedDict()
_parsed_cache_lock = threading.Lock()


def clear_parsed_cache() -> None:
    with _parsed_cache_lock:
        _parsed_cache.clear()


def parse_cached(cache_key: str, filename: str, tmp_path: str, languages: str) -> CanonicalDoc:
    with _parsed_cache_lock:
        cached = _parsed_cache.get(cache_key)
        if cached is not None:
            _parsed_cache.move_to_end(cache_key)
            return cached
    # No figure callbacks: captions are not source wording, and without them no model is ever called.
    doc = dispatch_by_extension(filename, tmp_path, languages=languages)
    with _parsed_cache_lock:
        _parsed_cache[cache_key] = doc
        _parsed_cache.move_to_end(cache_key)
        while len(_parsed_cache) > _PARSED_CACHE_MAX:
            _parsed_cache.popitem(last=False)
    return doc


def _same_page(ref: SourceRef, page: int | None) -> bool:
    # Only a loader-given page scopes offsets (PDF offsets restart per page, a pptx slide). A docx carries no page of its own:
    # a stored docx page is a rendering estimate added after parsing, and its offsets are document-wide.
    return page is None or ref.page is None or ref.page == page


def _is_source_block(block: Block) -> bool:
    return (
        block.kind != BlockKind.FIGURE
        and not block.text.startswith(_SYNTHETIC_NOTE_PREFIX)
        and bool(block.text.strip())
    )


def _overlaps(ref: SourceRef, start: int, end: int) -> bool:
    return ref.start_offset < end and ref.end_offset > start


def _row_text(row: list) -> str:
    return " | ".join(cell.text.strip() for cell in row)


def _table_text(table: Table, row_hint: str | None) -> str:
    rows = [row for row in table.cells if any(cell.text.strip() for cell in row)]
    hint = (row_hint or "").strip()
    if hint:
        matched = [row for row in rows if any(cell.text.strip() == hint for cell in row)]
        if matched:
            header = rows[0] if rows and any(cell.is_header for cell in rows[0]) else None
            if header is None and rows and rows[0] not in matched:
                # No header flag (many docx tables): the first row is still the only label the columns have.
                header = rows[0]
            rows = ([header] if header is not None and header not in matched else []) + matched
    return "\n".join(_row_text(row) for row in rows)


def _cap(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_EXCERPT_CHARS:
        return text, False
    cut = text[:MAX_EXCERPT_CHARS]
    boundary = max(cut.rfind(" "), cut.rfind("\n"), cut.rfind("\t"))
    if boundary >= int(MAX_EXCERPT_CHARS * _MIN_KEEP_RATIO):
        cut = cut[:boundary]
    return cut.rstrip(), True


def _result(text: str, kind: ExcerptKind) -> SourceExcerpt:
    if not text.strip():
        return _UNAVAILABLE
    capped, truncated = _cap(text)
    return SourceExcerpt(text=capped, truncated=truncated, kind=kind)


def _order_key(ref: SourceRef) -> tuple[int, int]:
    return (ref.page or 0, ref.start_offset)


def _section_text(doc: CanonicalDoc, anchor: Block) -> str:
    elements: list[tuple[tuple[int, int], Block | Table]] = [
        (_order_key(b.source_ref), b) for b in doc.blocks if _is_source_block(b)
    ] + [
        (_order_key(t.source_ref), t)
        for t in doc.tables
        if (t.source_ref.start_offset, t.source_ref.end_offset) != (0, 0)
    ]
    elements.sort(key=lambda pair: pair[0])
    start_index = next(i for i, (_key, element) in enumerate(elements) if element is anchor)
    anchor_level = (anchor.heading_level or 1) if anchor.kind == BlockKind.HEADING else None
    parts: list[str] = [anchor.text.strip()]
    for _key, element in elements[start_index + 1 :]:
        if isinstance(element, Block) and element.kind == BlockKind.HEADING:
            level = element.heading_level or 1
            # A heading anchor runs to the next heading at its level or above; any other anchor to the next heading at all.
            if anchor_level is None or level <= anchor_level:
                break
        parts.append(
            element.text.strip() if isinstance(element, Block) else _table_text(element, None)
        )
        if sum(len(p) + 2 for p in parts) > MAX_EXCERPT_CHARS:
            break
    return "\n\n".join(p for p in parts if p)


def excerpt_for_span(
    doc: CanonicalDoc,
    start_offset: int,
    end_offset: int,
    page: int | None = None,
    extent: Literal["span", "section"] = "span",
    row_hint: str | None = None,
) -> SourceExcerpt:
    if start_offset < 0 or end_offset <= start_offset:
        return _UNAVAILABLE

    for table in doc.tables:
        ref = table.source_ref
        if (ref.start_offset, ref.end_offset) == (start_offset, end_offset) and _same_page(
            ref, page
        ):
            return _result(_table_text(table, row_hint), "table")

    overlapping = [
        b
        for b in doc.blocks
        if _overlaps(b.source_ref, start_offset, end_offset) and _same_page(b.source_ref, page)
    ]
    source_blocks = [b for b in overlapping if _is_source_block(b)]
    if not source_blocks:
        return _UNAVAILABLE
    if extent == "section":
        return _result(_section_text(doc, source_blocks[0]), "section")
    return _result("\n\n".join(b.text.strip() for b in source_blocks), "text")
