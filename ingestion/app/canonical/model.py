# ingestion/app/canonical/model.py
from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


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
      text, NOT an offset into the underlying .docx XML/zip structure. A
      Table object shares this same counter (a real, distinct offset per
      table, confirmed live) -- but ALL ROWS of one table share that one
      table-level offset, since no extraction library exposes a natural
      per-row text offset.
    - other loaders (pdf/xlsx/csv, etc.): a Table object still gets the
      (0, 0) placeholder where no natural table-region offset exists.
    A later phase (BASELINE fidelity hashing) must account for these
    per-loader differences rather than assuming a single offset contract.

    section_path/page_end/page_provenance are ADDITIVE provenance for the
    review UI (which section/pages a node was parsed from) and deliberately
    excluded from _hash_identity's input (document_path/start_offset/
    end_offset only, see tree_builder.py) -- widening them on a description
    fold must never change a node's identity_hash/fidelity_hash, or a
    re-run would look like a new item and duplicate-create in ADO.

    - section_path: root-first heading/section labels for the
      section this ref was parsed from (e.g. ["3 Power", "3.2 Backplane"]).
      [] when no heading ancestry applies (e.g. a document with no headings
      at all) rather than a fabricated single-element path.
    - page_end: the last page this node's folded content covers. None
      means "same as page, or unknown" -- never set without page also
      being set.
    - page_provenance: None when page/page_end came from the file's own
      real pagination (PDF page boundaries, OCR page images, pptx slide
      index) -- the only sources that exist today. "rendered" when derived
      by re-rendering the source through a different layout engine (e.g.
      a docx converted to PDF via LibreOffice for pagination purposes --
      an approximation of the ORIGINAL application's pagination, not a
      ground truth). "interpolated" when bracketed between two confidently
      matched anchors rather than directly matched itself. The review UI
      uses this to render an honest "(approx.)" qualifier instead of
      presenting a rendered/interpolated page number with the same
      confidence as a real one.
    """

    document_path: str
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    page: int | None = None
    page_end: int | None = None
    page_provenance: str | None = None
    section_path: list[str] = Field(default_factory=list)


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


class TableCell(BaseModel):
    text: str
    colspan: int = Field(default=1, ge=1)
    rowspan: int = Field(default=1, ge=1)
    is_header: bool = False
    # Uniform-bold rule (see docx_loader.py/xlsx_loader.py's own extraction
    # docstrings): a cell is bold only if EVERY run containing non-whitespace
    # text is bold. A "first non-empty run" rule was considered and rejected
    # -- it mis-fires badly on a bold label prefix ("*Note:* rest of
    # sentence"), bolding the entire cell for what should read as a bold
    # PREFIX only. Partial-run bold isn't modeled at all in v1 (would need a
    # runs: list[TextRun] shape); uniform-bold is conservative and has near-
    # zero false positives against the actual use case (a wholly-bold header/
    # emphasis cell).
    bold: bool = False
    # Normalized #rrggbb, CONTRAST-ADAPTED before storage -- never the raw
    # source value. "No fill" (auto/none/white/near-white, relative luminance
    # > 0.92) is normalized to None, not a literal white -- rendering a
    # literal white background is exactly the failure mode this exists to
    # avoid (a white patch glaring in ADO's dark theme). See
    # tree_builder.py's contrast-adaptation implementation for the full
    # algorithm (docs/superpowers/specs/2026-08-12-table-fidelity-design.md).
    background_color: str | None = None
    text_color: str | None = None
    align: Literal["left", "center", "right", "justify"] | None = None
    # Set by pdf_loader.py's _cell_ocr_recovery when this cell's text could
    # not be extracted directly (pdfplumber found zero real characters at
    # this grid position) and was instead reconstructed by rendering the
    # page to pixels and OCR-ing this cell's own cropped region -- see
    # docs/superpowers/specs/2026-08-16-pdf-table-header-ocr-recovery-design.md.
    # PDF-only (that spec's Decision 4); never True for a spanned (None)
    # grid position, which has no TableCell at all. This field itself
    # carries no reviewer-facing text -- it's the bridge value CanonicalDoc
    # needs since it has no warnings concept of its own (same bridging
    # convention as Figure.caption_status, see that field's own docstring);
    # tree_builder.py/llm_leveling.py turn a table with any True cell into
    # one IntegrityWarning(WarningKind.OCR_RECOVERED_TABLE_TEXT).
    ocr_recovered: bool = False
    # Set when this cell's own DOCX markup contains a nested table --
    # tables-within-tables have no representation in the canonical model
    # (TableCell.text is plain text, not a place to embed a second grid),
    # so the nested table's own content is not extracted at all. This
    # field is the bridge value CanonicalDoc needs (same convention as
    # ocr_recovered just above); tree_builder.py/llm_leveling.py turn a
    # table with any True cell into one IntegrityWarning
    # (WarningKind.NESTED_TABLE_DROPPED) instead of leaking a literal
    # marker string into the cell's own rendered text.
    nested_table_dropped: bool = False


class Table(BaseModel):
    id: str
    # Row-major grid. None at a position means SPANNED -- absorbed by a
    # preceding cell's colspan/rowspan, render NO <td> there. A real
    # TableCell with text="" at a position is a genuine GAP (e.g. an empty
    # PDF-detected cell with no span covering it) -- render an EMPTY <td>.
    # These two are NOT interchangeable: conflating them produces
    # structurally broken tables on any document with real gaps (confirmed
    # live against pdfplumber's own output -- a spanned position has
    # bbox=None under a wider origin cell; a genuine gap has a normal-width
    # bbox with merely empty text). Every row must have the same length
    # (validated below) -- a colspan/rowspan/gridBefore/gridAfter mismatch
    # producing ragged rows is a bug, not a valid shape.
    cells: list[list[TableCell | None]]
    # Fractions of table width, NEVER source units (twips/EMU/character-
    # width/points) -- the renderer must never see a source unit, only
    # fractions, same "don't let raw source geometry reach the layout" rule
    # that fixed the earlier figure-image overflow bug this session.
    column_widths: list[float] | None = None
    # Deliberately coarse -- not a full per-side/per-cell border spec.
    border_style: Literal["none", "grid", "outer"] | None = None
    # None = read from explicit source markup (docx per-cell w:shd/w:tcBorders,
    # xlsx cell.fill/border, pptx explicit cell XML). "heuristic" = derived by
    # geometric/heuristic inference (PDF only, e.g. bbox-overlap for
    # background, font-name substring match for bold). Mirrors SourceRef.
    # page_provenance's exact precedent (str, not Literal, values documented
    # here in prose) -- lets the review UI render an honest "(approx.
    # styling)" qualifier instead of showing a heuristic guess with the same
    # confidence as a real, explicitly-authored value.
    style_provenance: str | None = None
    caption: str | None = None
    source_ref: SourceRef

    @model_validator(mode="after")
    def _validate_rectangular_grid(self) -> "Table":
        if self.cells and len({len(row) for row in self.cells}) > 1:
            raise ValueError(
                f"Table {self.id!r} has ragged rows (lengths "
                f"{sorted({len(row) for row in self.cells})}) -- every row must have "
                "the same grid width; a colspan/rowspan/gridBefore/gridAfter "
                "mismatch producing ragged rows is a bug in the loader, not a "
                "valid table shape."
            )
        return self


def plain_text_rows(table: Table) -> list[list[str]]:
    """Derives the flat `list[list[str]]` grid the pre-TableCell `Table.rows`
    shape used to be, straight from `Table.cells` -- "" for a spanned
    position (None) exactly matching the old convention's continuation-cell
    placeholder, and a real gap's own (already-empty) text for a gap. This
    is the ONLY thing table-detection/plain-text consumers that predate this
    feature need (id_hierarchy.py's rows_from_table/parsed_id_rows_from_table,
    llm_leveling.py's _table_to_markdown non-empty check, table_groups.py) --
    none of them have any positional/dimensional assumption beyond a
    rectangular grid, which Table's own validator already guarantees. Using
    this instead of hand-rolling the same derivation keeps every one of
    those call sites decoupled from the styling model entirely."""
    return [[cell.text if cell is not None else "" for cell in row] for row in table.cells]


class Figure(BaseModel):
    id: str
    caption: str | None = None
    # The author's own short title for this figure -- e.g. "CubeConnect PCB
    # (PC104 Variants) - Interior (Back) View", parsed from a "Figure N:
    # Title" caption line in the source document itself (see
    # figure_utils.py's extract_figure_title). Distinct from `caption`,
    # which is the vision model's own prose description: `name` is a short
    # noun phrase meant for display (UI label, ADO attachment filename),
    # `caption` is a paragraph meant for search/context. Falls back to an
    # LLM-generated short title (main.py's _describe_figure, via the same
    # caption_status_out side channel) only when the document provides no
    # caption line of its own -- the document's own name always wins.
    name: str | None = None
    source_ref: SourceRef
    # Why `caption` is None, when it is -- disambiguates the two independent
    # causes that previously both collapsed into the same signal (see
    # WorkItemNode.uncaptioned_figure_ids's own docstring, tree-level
    # WarningKind.VISION_CAPTIONING_DISABLED covers the third cause, vision
    # being off for the whole run). "insignificant": the vision model judged
    # the figure decorative/non-technical (result.significant is False, live
    # or cached). "vision_failed": the vision call itself errored/timed out
    # or returned an unparseable response (main.py's _describe_figure
    # ambiguous-result branch). None/absent both when a real caption was
    # produced AND when vision never ran for this figure at all (disabled
    # for the whole run, or BASELINE mode) -- the latter is deliberately NOT
    # distinguished here, that's what the tree-level warning is for. Set by
    # main.py's _describe_figure_with_progress after the loader returns, via
    # a per-request figure_id-keyed side channel (describe_figure's own
    # signature is shared with every loader and KB-ingestion caller, so it
    # can't grow a new required return shape without touching all of them).
    caption_status: str | None = None


class CanonicalDoc(BaseModel):
    document: Document
    blocks: list[Block] = Field(default_factory=list)
    tables: list[Table] = Field(default_factory=list)
    figures: list[Figure] = Field(default_factory=list)
    # Figure ids whose store() call (main.py's _describe_figure_with_progress)
    # raised during this /ingest -- the figure was still captioned, but its
    # bytes never made it to storage, so it won't be viewable/attachable
    # later. Storage happens here, in /ingest, not in /level, so this can
    # never surface as a WorkItemTree IntegrityWarning; the orchestrator
    # turns a non-empty list into its own synthesized WarningRecord (mirrors
    # ado_verification_failed's precedent, see workitem/model.py's
    # WarningKind docstring).
    failed_figure_storage_ids: list[str] = Field(default_factory=list)
    # Whether main.py's /ingest actually opened the vision-LLM gate for this
    # document (see ingest()'s own `vision_active = _vision_client is not
    # None and not skip_vision and mode == "survey"`) -- False for every
    # BASELINE doc (vision never runs there), a preview call (skip_vision),
    # or when no LLM_VISION_MODEL is configured at all. Round-tripped through
    # here (not a new /level query param) because /level's own `doc` request
    # body IS this same CanonicalDoc, already flowing unchanged from
    # /ingest's response through the orchestrator's ingestionClient.level()
    # call -- the only way this signal can reach /level's response_model=
    # CanonicalDoc-filtered /ingest boundary at all. Consumed by /level to
    # emit exactly one tree-level WarningKind.VISION_CAPTIONING_DISABLED
    # warning (never a per-figure one) when this is False and doc.figures is
    # non-empty -- see main.py's _append_vision_disabled_warning.
    vision_active: bool = False
