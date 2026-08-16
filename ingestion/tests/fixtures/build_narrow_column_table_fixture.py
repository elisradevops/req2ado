"""Run once to (re)generate narrow_column_table.pdf:
`python build_narrow_column_table_fixture.py`.

Safety-net fixture for `_DECORATIVE_RECT_SNAP_TOLERANCE` (pdf_loader.py):
proves the tolerance bump doesn't blindly merge two REAL, distinct column
boundaries that happen to sit close together -- only the decorative-inset
pattern it targets. Uses an 18pt-wide real column (a realistic minimum for
a flag/checkbox-style column with legible single-character content; nothing
narrower can hold readable text at any normal font size) with plain
stroked borders and no decorative double-rect fill at all. Confirmed
empirically: at the chosen tolerance (5.5), this column's own two
boundaries stay distinct (18pt is comfortably outside the tolerance); a
genuinely pathological column wafer-thin enough to fall inside the
tolerance (well under 5.5pt) cannot hold legible text at all, so is not a
realistic table shape this fixture needs to defend against.
"""
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

fixtures_dir = Path(__file__).parent
out_path = fixtures_dir / "narrow_column_table.pdf"

c = canvas.Canvas(str(out_path), pagesize=letter)

COL_BOUNDS = [50, 200, 218, 368]  # Name (150pt) | Flag (18pt) | Value (150pt)
ROW_TOPS = [700, 670, 640]
ROW_H = 30
labels_per_row = [
    ["Name", "Flag", "Value"],
    ["Alice", "Y", "100"],
    ["Bob", "N", "200"],
]

c.setStrokeColorRGB(0, 0, 0)
c.setFillColorRGB(0, 0, 0)

for row_index, top in enumerate(ROW_TOPS):
    bottom = top - ROW_H
    labels = labels_per_row[row_index]
    for col_index in range(3):
        x0, x1 = COL_BOUNDS[col_index], COL_BOUNDS[col_index + 1]
        c.rect(x0, bottom, x1 - x0, ROW_H, stroke=1, fill=0)
        c.drawString(x0 + 2, bottom + ROW_H / 2 - 4, labels[col_index])

c.showPage()
c.save()
print(f"wrote {out_path}")
