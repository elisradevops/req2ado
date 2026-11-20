# ingestion/app/dispatch.py
from __future__ import annotations

import hashlib
import re
import tempfile
from collections.abc import Callable
from pathlib import Path

from fastapi import HTTPException

from app.canonical.markup import normalize_block_markup
from app.canonical.model import BlockKind, CanonicalDoc
from app.loaders.csv_loader import load_csv
from app.loaders.docx_loader import load_docx
from app.loaders.image_loader import load_image
from app.loaders.ocr import load_pdf_with_ocr_fallback
from app.loaders.office_convert import LEGACY_CONVERSIONS, convert_legacy_office
from app.loaders.pptx_loader import load_pptx
from app.loaders.rtf_loader import load_rtf
from app.loaders.text_loader import load_markdown, load_txt
from app.loaders.xls_loader import XlsReadError, load_xls
from app.loaders.xlsx_loader import load_xlsx

_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif"}
_SUPPORTED_EXTENSIONS = {
    ".txt",
    ".md",
    ".docx",
    ".xlsx",
    ".pdf",
    ".pptx",
    ".csv",
    ".rtf",
    # Word 97-2003 is converted to .docx first (loaders/office_convert.py); Excel 97-2003 is read by xlrd (loaders/xls_loader.py). Spelled
    # out, not spliced: orchestrator/test/allowed-extensions.drift-guard.spec.ts reads this literal.
    ".doc",
    ".xls",
    *_IMAGE_EXTENSIONS,
}

# Mirrors ocr.py's own _OPEN_TBD_PATTERN exactly (kept in sync by eye --
# both are one line) -- that module was the ONLY place this classification
# ever ran, so it silently never fired for docx/txt/xlsx-cell/native-text
# PDF content, even though the pattern itself has nothing OCR-specific
# about it. Applying it here, once, to every loader's own PARAGRAPH blocks
# closes that gap universally instead of teaching each loader its own copy.
# TBD, and OPEN followed by a colon, in any case; OPEN followed by a space only in capitals, so the ordinary word ("SOSA Open VPX",
# "open the hatch") is not a placeholder.
_OPEN_TBD_PATTERN = re.compile(r"(?i:\bTBD\b[:\s]|\bOPEN\b:)|\bOPEN\b\s")


def _classify_open_tbd_paragraphs(doc: CanonicalDoc) -> CanonicalDoc:
    """Reclassifies a PARAGRAPH block as OPEN_TBD when its text matches an
    "OPEN:"/"TBD:" marker -- previously only ever applied to OCR-recovered
    text (ocr.py), never to a docx/txt/native-text-PDF paragraph containing
    the exact same marker. Scoped to PARAGRAPH only, matching ocr.py's own
    reclassification rule exactly (it only ever turns a would-be PARAGRAPH
    into OPEN_TBD, never a HEADING/NOTE/FIGURE/LIST_ITEM) -- xlsx/csv table
    cells have no BlockKind concept at all (TableCell carries no `kind`
    field), so this can't reach that content; a real gap, but a separate,
    larger data-model question, not a bug in this pass."""
    for block in doc.blocks:
        if block.kind == BlockKind.PARAGRAPH and _OPEN_TBD_PATTERN.search(block.text):
            block.kind = BlockKind.OPEN_TBD
    return doc


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


def _unreadable_legacy_file(extension: str, newer: str) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail=(
            f"The {extension} file could not be read. It may be damaged or password-protected; "
            f"saving it as {newer} and uploading that will work."
        ),
    )


def _load_xls(tmp_path: str) -> CanonicalDoc:
    original_sha256 = hashlib.sha256(Path(tmp_path).read_bytes()).hexdigest()
    try:
        doc = load_xls(tmp_path)
    except XlsReadError as error:
        raise _unreadable_legacy_file(".xls", ".xlsx") from error
    doc.document.sha256 = original_sha256  # the rewritten workbook's bytes are not the upload's
    return doc


def _load_legacy_office(
    extension: str,
    tmp_path: str,
    describe_figure: Callable[[bytes], str] | None,
    on_figure_bytes: Callable[[bytes], None] | None,
) -> CanonicalDoc:
    """A .doc read through its converted .docx. A file that cannot be converted (damaged, password-protected, or no LibreOffice here) is
    refused with a message that says so, never read as something it is not."""
    original_sha256 = hashlib.sha256(Path(tmp_path).read_bytes()).hexdigest()
    # Figures are read from the converted file while it exists, so everything that needs it happens inside this block.
    with tempfile.TemporaryDirectory() as work_dir:
        converted = convert_legacy_office(tmp_path, extension, work_dir)
        if converted is None:
            raise _unreadable_legacy_file(extension, ".docx")
        doc = load_docx(converted, describe_figure=describe_figure, on_figure_bytes=on_figure_bytes)
    # The converted bytes differ from run to run (timestamps inside the container), so the hash that stands for this file is the upload's.
    doc.document.sha256 = original_sha256
    return doc


def dispatch_by_extension(
    filename: str,
    tmp_path: str,
    languages: str = "eng",
    describe_figure: Callable[[bytes], str] | None = None,
    on_figure_bytes: Callable[[bytes], None] | None = None,
    on_ocr_page: Callable[[int, int, int, int, str], None] | None = None,
) -> CanonicalDoc:
    extension = Path(filename).suffix.lower()
    if extension not in _SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file extension: {extension}")

    if extension == ".txt":
        doc = load_txt(tmp_path)
    elif extension == ".md":
        doc = load_markdown(tmp_path)
    elif extension == ".docx":
        doc = load_docx(tmp_path, describe_figure=describe_figure, on_figure_bytes=on_figure_bytes)
    elif extension == ".xlsx":
        doc = load_xlsx(tmp_path)
    elif extension == ".pptx":
        doc = load_pptx(tmp_path, describe_figure=describe_figure, on_figure_bytes=on_figure_bytes)
    elif extension in LEGACY_CONVERSIONS:
        doc = _load_legacy_office(extension, tmp_path, describe_figure, on_figure_bytes)
    elif extension == ".xls":
        doc = _load_xls(tmp_path)
    elif extension == ".csv":
        doc = load_csv(tmp_path)
        # The loader names the table after the file it was handed, which is a temporary path: the sheet is the uploaded file.
        for table in doc.tables:
            if table.caption == Path(tmp_path).stem:
                table.caption = Path(filename).stem
    elif extension == ".rtf":
        doc = load_rtf(tmp_path)
    elif extension in _IMAGE_EXTENSIONS:
        doc = load_image(tmp_path, describe_figure=describe_figure, on_figure_bytes=on_figure_bytes)
    else:
        doc = load_pdf_with_ocr_fallback(
            tmp_path,
            languages=languages,
            describe_figure=describe_figure,
            on_figure_bytes=on_figure_bytes,
            on_ocr_page=on_ocr_page,
        )
    # Markup inside running text (HTML pasted into a Word paragraph, an HTML block in Markdown, a tracker's rich text) becomes Markdown here, once, for
    # every format: a description is stored as Markdown and nothing downstream renders raw tags.
    doc = normalize_block_markup(doc)
    doc = _classify_open_tbd_paragraphs(doc)
    return _normalize_document_identity(doc, filename)
