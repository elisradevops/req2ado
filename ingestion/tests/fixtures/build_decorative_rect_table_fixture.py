"""Run once to (re)generate decorative_rect_table.pdf:
`python build_decorative_rect_table_fixture.py`.

Reproduces a real, root-caused table-geometry bug: some PDF-authoring tools
draw a styled/shaded table cell as TWO NESTED filled rects (a real outer
cell border/fill plus a decorative inset rect a few points inside it, for a
"rounded box" look) instead of a single flat fill. pdfplumber's default
`snap_x_tolerance` (3pt) treats the decorative inner rect's own edges as
real extra column/row boundaries, producing ghost columns in any row using
this style, and -- when the decorative fill is drawn as two stacked
half-height rects behind a header cell -- splitting that header into two
separate grid rows. Confirmed via direct inspection of a real ICD PDF
(cubeadcs_icd.pdf, "Table 26: Harness Details", page 39); this fixture
reproduces the same pattern at minimal scale (3 columns x 3 rows: a header
row with the stacked-half-height decorative fill, one shaded data row with
a single both-axes-inset decorative fill, one plain unshaded data row) so
the fix (`_DECORATIVE_RECT_SNAP_TOLERANCE` in pdf_loader.py) can be proven
without needing the full real document.
"""
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

fixtures_dir = Path(__file__).parent
out_path = fixtures_dir / "decorative_rect_table.pdf"

c = canvas.Canvas(str(out_path), pagesize=letter)

COL_X = [50, 150, 250]
COL_W = 100
ROW_TOPS = [700, 670, 640]  # header, shaded row, unshaded row (reportlab y-up)
ROW_H = 30
INSET = 5.5
GRAY = (0.85, 0.85, 0.85)

header_labels = ["ID", "Name", "Value"]
row1_labels = ["1", "Alice", "100"]
row2_labels = ["2", "Bob", "200"]

c.setFillColorRGB(0, 0, 0)

for row_index, (top, labels) in enumerate(zip(ROW_TOPS, [header_labels, row1_labels, row2_labels])):
    bottom = top - ROW_H
    for col_index, x in enumerate(COL_X):
        # Real cell border -- the TRUE grid boundary, matching the real
        # document's own reliance on stroked/filled rects (not vector lines)
        # for its actual table structure.
        c.setStrokeColorRGB(0, 0, 0)
        c.rect(x, bottom, COL_W, ROW_H, stroke=1, fill=0)

        if row_index == 0:
            # Header: decorative background drawn as TWO STACKED HALF-HEIGHT
            # fills -- reproduces the real document's header-split bug.
            c.setFillColorRGB(*GRAY)
            c.rect(x + INSET, bottom + ROW_H / 2, COL_W - 2 * INSET, ROW_H / 2, stroke=0, fill=1)
            c.rect(x + INSET, bottom, COL_W - 2 * INSET, ROW_H / 2, stroke=0, fill=1)
        elif row_index == 1:
            # Shaded data row: ONE decorative inset fill (inset both axes) --
            # reproduces the real document's ghost-column bug.
            c.setFillColorRGB(*GRAY)
            c.rect(x + INSET, bottom + INSET, COL_W - 2 * INSET, ROW_H - 2 * INSET, stroke=0, fill=1)
        # row_index == 2 (unshaded): no decorative fill at all.

        c.setFillColorRGB(0, 0, 0)
        c.drawString(x + 10, bottom + ROW_H / 2 - 4, labels[col_index])

c.showPage()
c.save()
print(f"wrote {out_path}")
