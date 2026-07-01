# ingestion/app/dispatch.py
from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from app.canonical.model import CanonicalDoc
from app.loaders.docx_loader import load_docx
from app.loaders.ocr import load_pdf_with_ocr_fallback
from app.loaders.text_loader import load_markdown, load_txt
from app.loaders.xlsx_loader import load_xlsx

_SUPPORTED_EXTENSIONS = {".txt", ".md", ".docx", ".xlsx", ".pdf"}


def dispatch_by_extension(filename: str, tmp_path: str, languages: str = "eng") -> CanonicalDoc:
    extension = Path(filename).suffix.lower()
    if extension not in _SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file extension: {extension}")

    if extension == ".txt":
        return load_txt(tmp_path)
    if extension == ".md":
        return load_markdown(tmp_path)
    if extension == ".docx":
        return load_docx(tmp_path)
    if extension == ".xlsx":
        return load_xlsx(tmp_path)
    return load_pdf_with_ocr_fallback(tmp_path, languages=languages)
