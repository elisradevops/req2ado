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


class BlockKind(str, Enum):
    HEADING = "heading"
    PARAGRAPH = "paragraph"
    LIST_ITEM = "list_item"
    TABLE = "table"
    FIGURE = "figure"
    NOTE = "note"
    OPEN_TBD = "open_tbd"


class SourceRef(BaseModel):
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
