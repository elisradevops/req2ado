# ingestion/app/canonical/model.py
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class DocumentFormat(str, Enum):
    TXT = "txt"
    MD = "md"
    DOCX = "docx"
    PDF = "pdf"
    PDF_SCANNED = "pdf_scanned"
    XLSX = "xlsx"
    PPTX = "pptx"
    CSV = "csv"
    RTF = "rtf"
    IMAGE = "image"


class BlockKind(str, Enum):
    HEADING = "heading"
    PARAGRAPH = "paragraph"
    LIST_ITEM = "list_item"
    TABLE = "table"
    FIGURE = "figure"
    NOTE = "note"
    OPEN_TBD = "open_tbd"


class SourceRef(BaseModel):
    """
    Offset semantics are loader-specific, not a uniform byte/char contract:
    - text/markdown loaders: real character offsets into the source file.
    - pdf loader: real character offsets, but relative to each page's
      independently-extracted text (not document-global).
    - docx loader: a synthetic running counter over extracted paragraph
      text, NOT an offset into the underlying .docx XML/zip structure.
    - all Table objects (every loader): placeholder (0, 0) — no extraction
      library exposes a natural text offset for a table region.
    A later phase (BASELINE fidelity hashing) must account for these
    per-loader differences rather than assuming a single offset contract.
    """

    document_path: str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    page: int | None = None


class Document(BaseModel):
    path: str
    format: DocumentFormat
    sha256: str


class Block(BaseModel):
    id: str
    kind: BlockKind
    text: str
    heading_level: int | None = Field(default=None, ge=1)
    number_label: str | None = None
    source_ref: SourceRef


class Table(BaseModel):
    id: str
    rows: list[list[str]]
    caption: str | None = None
    source_ref: SourceRef


class Figure(BaseModel):
    id: str
    caption: str | None = None
    source_ref: SourceRef


class CanonicalDoc(BaseModel):
    document: Document
    blocks: list[Block] = Field(default_factory=list)
    tables: list[Table] = Field(default_factory=list)
    figures: list[Figure] = Field(default_factory=list)
