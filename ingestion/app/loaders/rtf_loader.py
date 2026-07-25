from __future__ import annotations

import hashlib
from pathlib import Path

from striprtf.striprtf import rtf_to_text

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef


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

    text = rtf_to_text(raw.decode("utf-8", errors="replace"))

    blocks: list[Block] = []
    offset = 0
    for i, paragraph in enumerate(p for p in text.split("\n\n") if p.strip()):
        start = text.index(paragraph, offset)
        end = start + len(paragraph)
        offset = end
        blocks.append(
            Block(
                id=f"b{i}",
                kind=BlockKind.PARAGRAPH,
                text=paragraph.strip(),
                source_ref=SourceRef(document_path=path, start_offset=start, end_offset=end),
            )
        )
    return CanonicalDoc(document=document, blocks=blocks)
