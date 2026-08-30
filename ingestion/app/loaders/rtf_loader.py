from __future__ import annotations

import hashlib
from pathlib import Path

from striprtf.striprtf import rtf_to_text

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.loaders.encoding_utils import unsupported_encoding_note


def load_rtf(path: str) -> CanonicalDoc:
    """RTF formatting/embedded objects are discarded -- striprtf recovers
    plain text only, same MVP-level fidelity tradeoff as PDF's text
    extraction. Paragraph-split on blank lines, same convention as
    text_loader.load_txt, since RTF (like plain text) has no heading
    metadata of its own to detect."""
    file_path = Path(path)
    raw = file_path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()
    document = Document(path=path, format=DocumentFormat.RTF, sha256=sha256)

    decoded = raw.decode("utf-8", errors="replace")
    # errors="replace" never raises, so a non-UTF-8 RTF (e.g. CP1252/CP1255
    # content) degraded silently with no signal at all -- U+FFFD only ever
    # appears here as a result of that substitution, never as real document
    # content, so its presence is an exact, reliable detector.
    had_decode_error = "�" in decoded
    text = rtf_to_text(decoded)

    blocks: list[Block] = []
    block_id = 0
    if had_decode_error:
        blocks.append(unsupported_encoding_note(path, f"b{block_id}", "utf-8"))
        block_id += 1
    offset = 0
    for paragraph in (p for p in text.split("\n\n") if p.strip()):
        start = text.index(paragraph, offset)
        end = start + len(paragraph)
        offset = end
        blocks.append(
            Block(
                id=f"b{block_id}",
                kind=BlockKind.PARAGRAPH,
                text=paragraph.strip(),
                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
            )
        )
        block_id += 1
    return CanonicalDoc(document=document, blocks=blocks)
