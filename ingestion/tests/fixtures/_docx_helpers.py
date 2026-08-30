"""Shared helpers for the mock-PRD fixture builder scripts in this
directory (build_mock_prd_*_docx.py) -- not a pytest test module itself."""
from docx import Document as DocxDocument


def add_requirements_table(doc: DocxDocument, prefix: str, rows: list[tuple[str, str]]) -> None:
    table = doc.add_table(rows=1, cols=3)
    header = table.rows[0].cells
    header[0].text, header[1].text, header[2].text = "#", "Parameter", "Requirement / Value"
    for i, (parameter, requirement) in enumerate(rows):
        cells = table.add_row().cells
        cells[0].text = f"{prefix}-{i:03d}#"
        cells[1].text = parameter
        cells[2].text = requirement
