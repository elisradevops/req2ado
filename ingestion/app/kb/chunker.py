from __future__ import annotations

from pydantic import BaseModel

from app.canonical.model import Block, BlockKind, CanonicalDoc

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
    fixed-size window (MAX_BLOCKS_PER_CHUNK)."""
    has_headings = any(block.kind == BlockKind.HEADING for block in doc.blocks)
    if not has_headings:
        return _chunk_by_fixed_window(doc.blocks)
    return _chunk_by_heading(doc.blocks)


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
