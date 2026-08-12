from __future__ import annotations

import hashlib
from pathlib import Path

from openpyxl import load_workbook

from app.canonical.model import CanonicalDoc, Document, DocumentFormat, SourceRef, Table, TableCell


def load_xlsx(path: str) -> CanonicalDoc:
    file_path = Path(path)
    sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
    document = Document(path=path, format=DocumentFormat.XLSX, sha256=sha256)

    # NOTE: values_only=True still, no styling extracted yet -- real per-cell
    # span/alignment/is_header extraction (Phase 1 of
    # docs/superpowers/specs/2026-08-12-table-fidelity-design.md) requires
    # values_only=False (a real Cell object, not its bare value) plus
    # merged_cells.ranges -- deferred to that dedicated pass, not done here.
    workbook = load_workbook(filename=path, data_only=True)
    tables: list[Table] = []
    for sheet_index, sheet_name in enumerate(workbook.sheetnames):
        sheet = workbook[sheet_name]
        cells: list[list[TableCell]] = [
            [TableCell(text=str(cell) if cell is not None else "") for cell in row]
            for row in sheet.iter_rows(values_only=True)
        ]
        tables.append(
            Table(
                id=f"t{sheet_index}",
                cells=cells,
                caption=sheet_name,
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=0),
            )
        )

    return CanonicalDoc(document=document, tables=tables)
