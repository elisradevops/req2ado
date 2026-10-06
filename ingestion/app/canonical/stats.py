from __future__ import annotations

import re
from dataclasses import dataclass

from app.canonical.model import BlockKind, CanonicalDoc

# Scripts written without spaces between words. A whitespace split would count
# a whole sentence in these as one "word", so each such character counts as one
# unit instead (a close stand-in for how much text there is to read). Covers
# Hiragana, Katakana, CJK ideographs (incl. extension A) and Hangul syllables.
_NO_SPACE_SCRIPT = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯]")


def count_words(text: str) -> int:
    """Counts words for progress purposes: whitespace-separated tokens, plus
    one unit per character of a script that does not use spaces. Deterministic,
    never raises, and treats None-like/empty input as zero."""
    if not text:
        return 0
    spaceless = len(_NO_SPACE_SCRIPT.findall(text))
    remainder = _NO_SPACE_SCRIPT.sub(" ", text)
    return spaceless + len(remainder.split())


@dataclass(frozen=True)
class DocStats:
    """Exact counts of what is in a parsed document -- the denominators for the
    counted progress percentage and the 'your document' summary. Counted from
    the loader's own output, never estimated."""

    words: int
    blocks: int
    headings: int
    tables: int
    table_rows: int
    figures: int
    # Highest page number any block/table/figure carries, or None when the
    # format has no pagination (txt, md, xlsx, csv, plain docx).
    pages: int | None


def compute_doc_stats(doc: CanonicalDoc) -> DocStats:
    """Words are counted from source text only: block text (excluding TABLE and
    FIGURE blocks, whose content lives in `doc.tables` / `doc.figures`) plus
    every table cell. Figure captions are model-produced, not source text, so
    they are not counted. A merged cell appears once in the grid (its spanned
    positions are None) so it is not double counted."""
    words = 0
    headings = 0
    pages: list[int] = []

    for block in doc.blocks:
        if block.kind == BlockKind.HEADING:
            headings += 1
        if block.kind not in (BlockKind.TABLE, BlockKind.FIGURE):
            words += count_words(block.text)
        if block.source_ref.page is not None:
            pages.append(block.source_ref.page)

    table_rows = 0
    for table in doc.tables:
        table_rows += len(table.cells)
        for row in table.cells:
            for cell in row:
                if cell is not None:
                    words += count_words(cell.text)
        if table.source_ref.page is not None:
            pages.append(table.source_ref.page)

    for figure in doc.figures:
        if figure.source_ref.page is not None:
            pages.append(figure.source_ref.page)

    return DocStats(
        words=words,
        blocks=len(doc.blocks),
        headings=headings,
        tables=len(doc.tables),
        table_rows=table_rows,
        figures=len(doc.figures),
        pages=max(pages) if pages else None,
    )
