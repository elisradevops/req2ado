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
        return load_txt(tmp_path)
    if extension == ".md":
        return load_markdown(tmp_path)
    if extension == ".docx":
        return load_docx(tmp_path, describe_figure=describe_figure)
    if extension == ".xlsx":
        return load_xlsx(tmp_path)
    if extension == ".pptx":
        return load_pptx(tmp_path, describe_figure=describe_figure)
    if extension == ".csv":
        return load_csv(tmp_path)
    if extension == ".rtf":
        return load_rtf(tmp_path)
    if extension in _IMAGE_EXTENSIONS:
        return load_image(tmp_path, describe_figure=describe_figure)
    return load_pdf_with_ocr_fallback(tmp_path, languages=languages, describe_figure=describe_figure)
