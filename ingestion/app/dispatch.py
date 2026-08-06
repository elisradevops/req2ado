# ingestion/app/dispatch.py
from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from app.canonical.model import CanonicalDoc
from app.loaders.csv_loader import load_csv
from app.loaders.docx_loader import load_docx
from app.loaders.image_loader import load_image
from app.loaders.ocr import load_pdf_with_ocr_fallback
from app.loaders.pptx_loader import load_pptx
from app.loaders.rtf_loader import load_rtf
from app.loaders.text_loader import load_markdown, load_txt
from app.loaders.xlsx_loader import load_xlsx

_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif"}
_SUPPORTED_EXTENSIONS = {".txt", ".md", ".docx", ".xlsx", ".pdf", ".pptx", ".csv", ".rtf", *_IMAGE_EXTENSIONS}


def _normalize_document_identity(doc: CanonicalDoc, filename: str) -> CanonicalDoc:
    """Every loader is handed `tmp_path` (a fresh `tempfile.NamedTemporaryFile`
    path, random per upload) to actually read the file from disk, and until
    this function existed, that SAME ephemeral path leaked into every
    SourceRef.document_path and Document.path it produced. Two confirmed
    real bugs from that: (1) identity_hash (tree_builder._hash_identity)
    folds document_path into its input, so two uploads of the byte-identical
    file NEVER produced the same hash -- idempotent re-run was broken for
    every mode, not just SURVEY's separately-known LLM-text instability
    (live-confirmed via golden-e2e's job #2 100%-reuse assertion failing).
    (2) _derive_doc_title (tree_builder.py) falls back to
    Path(doc.document.path).stem for a headingless document's title --
    that was rendering the temp file's random stem (e.g. "tmpy7dolux4") as
    the document's title, not the real uploaded filename.
    Rewritten here, once, centrally -- right after loading, before this
    CanonicalDoc reaches anything that hashes or displays either field --
    rather than threading a second "identity path" parameter through all 9
    loaders' internals."""
    doc.document.path = filename
    for block in doc.blocks:
        block.source_ref.document_path = filename
    for table in doc.tables:
        table.source_ref.document_path = filename
    for figure in doc.figures:
        figure.source_ref.document_path = filename
    return doc


def dispatch_by_extension(
    filename: str,
    tmp_path: str,
    languages: str = "eng",
    describe_figure: Callable[[bytes], str] | None = None,
) -> CanonicalDoc:
    extension = Path(filename).suffix.lower()
    if extension not in _SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file extension: {extension}")

    if extension == ".txt":
        doc = load_txt(tmp_path)
    elif extension == ".md":
        doc = load_markdown(tmp_path)
    elif extension == ".docx":
        doc = load_docx(tmp_path, describe_figure=describe_figure)
    elif extension == ".xlsx":
        doc = load_xlsx(tmp_path)
    elif extension == ".pptx":
        doc = load_pptx(tmp_path, describe_figure=describe_figure)
    elif extension == ".csv":
        doc = load_csv(tmp_path)
    elif extension == ".rtf":
        doc = load_rtf(tmp_path)
    elif extension in _IMAGE_EXTENSIONS:
        doc = load_image(tmp_path, describe_figure=describe_figure)
    else:
        doc = load_pdf_with_ocr_fallback(tmp_path, languages=languages, describe_figure=describe_figure)
    return _normalize_document_identity(doc, filename)
