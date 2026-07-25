from __future__ import annotations

from pydantic import BaseModel

from app.canonical.model import Block, BlockKind, CanonicalDoc, Table
from app.leveling.llm_leveling import _table_to_markdown

# Fallback window for documents with no heading structure at all — keeps
# chunks a reasonable retrieval unit instead of one giant chunk per file.
MAX_BLOCKS_PER_CHUNK = 10


class KbChunk(BaseModel):
    text: str
    chunk_index: int


def chunk_canonical_doc(doc: CanonicalDoc) -> list[KbChunk]:
    """Groups a CanonicalDoc's blocks into chunks by heading section: a
    HEADING block starts a new chunk unless it's a sub-heading (deeper
    level) of the currently-open section, in which case it joins that
    chunk. Documents with no heading blocks at all fall back to a
    fixed-size window (MAX_BLOCKS_PER_CHUNK).

    doc.tables (previously ignored entirely -- a table-only KB document,
    e.g. a csv/xlsx upload, silently produced ZERO chunks and nothing was
    ever retrievable from it) are then appended, one chunk per table via
    _table_chunks. This keeps block-derived chunk_index numbering exactly
    as before (byte-identical to pre-table-support behavior for any
    doc.tables == [] document) -- table chunks are simply added after."""
    has_headings = any(block.kind == BlockKind.HEADING for block in doc.blocks)
    block_chunks = _chunk_by_fixed_window(doc.blocks) if not has_headings else _chunk_by_heading(doc.blocks)
    return block_chunks + _table_chunks(doc.tables, start_index=len(block_chunks))


def _table_chunks(tables: list[Table], start_index: int) -> list[KbChunk]:
    """One chunk per table, rendered via the SAME _table_to_markdown helper
    render_section (SURVEY analysis) already uses for prompt text -- a
    table with no non-blank rows renders to None and is skipped, not turned
    into an empty chunk (mirrors _table_to_markdown's own null-check
    convention). A table's caption (e.g. a CSV's filename stem, an xlsx
    sheet name), when present, is prepended so the retrieval snippet
    identifies which table it came from."""
    chunks: list[KbChunk] = []
    for table in tables:
        markdown = _table_to_markdown(table)
        if markdown is None:
            continue
        text = f"{table.caption}\n\n{markdown}" if table.caption else markdown
        chunks.append(KbChunk(text=text, chunk_index=start_index + len(chunks)))
    return chunks


def _chunk_by_heading(blocks: list[Block]) -> list[KbChunk]:
    chunks: list[KbChunk] = []
    current_texts: list[str] = []
    current_level: int | None = None

    def flush() -> None:
        if current_texts:
            chunks.append(KbChunk(text="\n".join(current_texts), chunk_index=len(chunks)))

    for block in blocks:
        starts_new_section = block.kind == BlockKind.HEADING and (
            current_level is None or block.heading_level is None or block.heading_level <= current_level
        )
        if starts_new_section:
            flush()
            current_texts = [block.text]
            current_level = block.heading_level
        else:
            current_texts.append(block.text)
    flush()
    return chunks


def _chunk_by_fixed_window(blocks: list[Block]) -> list[KbChunk]:
    chunks: list[KbChunk] = []
    for start in range(0, len(blocks), MAX_BLOCKS_PER_CHUNK):
        window = blocks[start : start + MAX_BLOCKS_PER_CHUNK]
        chunks.append(KbChunk(text="\n".join(b.text for b in window), chunk_index=len(chunks)))
    return chunks
