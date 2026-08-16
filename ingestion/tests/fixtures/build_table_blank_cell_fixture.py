"""Run once to (re)generate table_with_blank_cell.pdf:
`python build_table_blank_cell_fixture.py`.

Produces a PDF with one ruled table, every cell real text EXCEPT one
genuinely blank data cell (real geometry, no image, no text) -- proves
OCR recovery must never fire for legitimate empty data (see
test_table_ocr_recovery_never_calls_ocr_for_a_genuinely_blank_cell in
test_pdf_loader.py). Kept as its own minimal fixture, separate from
table_with_image_header.pdf, so this regression property is provable
without any interaction with that fixture's real (mocked-out) OCR call.
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle

fixtures_dir = Path(__file__).parent
out_path = fixtures_dir / "table_with_blank_cell.pdf"

data = [
    ["ID", "Name"],
    ["1", "Alpha"],
    ["2", ""],
]
table = Table(data, colWidths=[100, 150])
table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 1, colors.black)]))

doc = SimpleDocTemplate(str(out_path), pagesize=letter)
doc.build([table])

print(f"wrote {out_path}")
