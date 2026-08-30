from __future__ import annotations

import csv
import hashlib
import io
from pathlib import Path

from app.canonical.model import CanonicalDoc, Document, DocumentFormat, SourceRef, Table, TableCell
from app.loaders.encoding_utils import read_text_degrading, unsupported_encoding_note


def load_csv(path: str) -> CanonicalDoc:
    """A CSV has no heading/sheet structure at all -- one Table for the
    whole file (caption = filename stem), same table-only shape xlsx_loader
    produces for a single sheet. tree_builder's headingless-grouping rule
    already handles a blocks=[] + tables=[...] document (see
    _build_headingless_tree), so no special-casing is needed downstream.
    utf-8-sig strips a BOM if present (common from Excel-exported CSVs)
    without affecting BOM-less files."""
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.CSV, sha256=sha256)

    text, had_decode_error = read_text_degrading(file_path, encoding="utf-8-sig")
    rows = [row for row in csv.reader(io.StringIO(text, newline=""))]

    # A malformed/inconsistent CSV can have ragged row lengths (unlike a
    # real table) -- the pre-TableCell `rows: list[list[str]]` shape
    # tolerated this freely, but `Table.cells` now validates a rectangular
    # grid (needed for every OTHER loader, where a ragged grid is a real
    # colspan/rowspan bug). Pad short rows with "" cells to the widest row's
    # length rather than let a merely-ragged CSV raise -- this is genuinely
    # different from a structural bug in a spanned-cell format.
    max_width = max((len(row) for row in rows), default=0)
    table = Table(
        id="t0",
        # CSV has no styling concept at all (plain delimited text) -- every
        # cell is a bare TableCell with no span/header/color/alignment info,
        # never upgraded by a later phase (unlike PDF, which gets real
        # heuristic extraction in Phase 4).
        cells=[[TableCell(text=cell) for cell in row] + [TableCell(text="")] * (max_width - len(row)) for row in rows],
        caption=file_path.stem,
        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
    )
    blocks = [unsupported_encoding_note(path, "b0", "utf-8-sig")] if had_decode_error else []
    return CanonicalDoc(document=document, blocks=blocks, tables=[table])
