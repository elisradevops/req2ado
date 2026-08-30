from __future__ import annotations

from pathlib import Path

from app.canonical.model import Block, BlockKind, SourceRef


def read_text_degrading(file_path: Path, *, encoding: str = "utf-8") -> tuple[str, bool]:
    """Reads `file_path` as text, degrading rather than raising on content
    that isn't valid `encoding` (e.g. a Hebrew CP1255 file uploaded as
    .txt/.csv/.md) -- matches this codebase's own degrade-don't-raise
    discipline elsewhere (OCR/vision fail-open, dedup-judge fail-open,
    etc.) instead of aborting the whole ingestion over one bad byte
    sequence. Returns `(text, had_decode_error)`; a caller should surface a
    real `[UNSUPPORTED: ...]` NOTE block (see `unsupported_encoding_note`)
    when the second value is True, rather than degrading silently."""
    raw = file_path.read_bytes()
    try:
        return raw.decode(encoding), False
    except UnicodeDecodeError:
        return raw.decode(encoding, errors="replace"), True


def unsupported_encoding_note(document_path: str, block_id: str, encoding: str) -> Block:
    """The loader-emitted diagnostic placeholder tree_builder.py's
    `_is_unsupported_content_note` already recognizes by its `[UNSUPPORTED:`
    text prefix (BlockKind.NOTE) -- turns into a real, visible warning
    downstream instead of the corruption passing through silently."""
    return Block(
        id=block_id,
        kind=BlockKind.NOTE,
        text=f"[UNSUPPORTED: file contains bytes that are not valid {encoding} -- some characters were replaced with a placeholder and may be corrupted]",
        source_ref=SourceRef(document_path=document_path, start_offset=0, end_offset=0),
    )
