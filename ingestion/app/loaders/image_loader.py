from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Callable

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef


def load_image(path: str, describe_figure: Callable[[bytes], str | None] | None = None) -> CanonicalDoc:
    """A standalone image file (not embedded in a docx/pptx) is treated as
    ONE Figure + ONE FIGURE-kind Block spanning the whole document -- there
    is no other content to extract. `describe_figure` uses the SAME
    single-arg (image bytes -> caption) convention as load_docx/load_pptx --
    the caller (app.main's dispatch_by_extension wiring) is responsible for
    closing over this file's own real mime type (via mimetypes.guess_type)
    so the vision call's data URI isn't mislabeled as image/png for a real
    JPEG/GIF/etc (see OrchestratorVisionClient.describe_figure's own
    docstring), keeping every loader's describe_figure parameter the same
    shape. None (the default) leaves the figure as a bare '[FIGURE: none]'
    placeholder. A captioning failure never raises -- it degrades to the
    placeholder, since a Figure with no caption is a normal (if less useful)
    outcome, not a broken document."""
    file_path = Path(path)
    content = file_path.read_bytes()
    sha256 = hashlib.sha256(content).hexdigest()
    document = Document(path=path, format=DocumentFormat.IMAGE, sha256=sha256)

    caption = None
    if describe_figure is not None:
        try:
            caption = describe_figure(content)
        except Exception:  # noqa: BLE001 -- a vision failure must not abort ingestion
            caption = None

    figure = Figure(id="f0", caption=caption, source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0))
    block = Block(
        id="b0",
        kind=BlockKind.FIGURE,
        text=f"[FIGURE: {caption or 'none'}]",
        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
    )
    return CanonicalDoc(document=document, blocks=[block], figures=[figure])
