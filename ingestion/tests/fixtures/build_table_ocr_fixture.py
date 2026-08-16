"""Run once to (re)generate table_with_image_header.pdf:
`python build_table_ocr_fixture.py`.

Produces a PDF with one ruled table whose header row mixes a real-text
label ("ID") with one cell whose "text" is actually a small raster image
of the word "Label" -- mirroring cubeadcs_icd.pdf's real-world bug (a
table header authored as an embedded image, not font glyphs), confirmed
via direct pdfplumber inspection to produce the same signature: zero
page.chars in that cell's bbox despite the label being visibly present
when the page is rendered. The trailing data-row cell is intentionally
left blank (real geometry, genuinely empty) so the SAME fixture also
supports proving OCR recovery does not misfire on legitimate empty data
(see test_build_pdf_table_grid_calls_ocr_recovery_only_for_empty_text_cells
in test_pdf_loader.py, and the dedicated blank-cell fixture/regression
test in build_table_blank_cell_fixture.py for the OCR-never-called case).

A leading "1 Overview" paragraph precedes the table. Without it, this
fixture's own header-label image is ALSO independently detected by
pdf_loader.py as a page-level Figure (unrelated, pre-existing,
correct behavior -- any embedded raster image on a page becomes its own
Figure/FIGURE block regardless of also sitting inside a table cell), and
with no other block resolving a real depth, build_baseline_tree would
route the whole document through _build_headingless_tree instead of the
structured per-branch path -- which processes doc.blocks OR doc.tables,
never both, silently dropping this fixture's table (and its OCR warning)
entirely. Empirically confirmed via direct load_pdf()/build_baseline_tree()
inspection. The numbered paragraph resolves a real depth via
depth.py's own numbering check (independent of pdf_loader's font-size
heading heuristic), keeping this fixture on the structured path where the
table folds into an open node and its OCR-recovery warning is emitted --
the actual behavior this fixture and its end-to-end test exist to prove.
"""
from pathlib import Path

from PIL import Image as PILImage, ImageDraw
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle
from reportlab.platypus.flowables import Image as RLImage

fixtures_dir = Path(__file__).parent
label_image_path = fixtures_dir / "_header_label.png"
out_path = fixtures_dir / "table_with_image_header.pdf"

img = PILImage.new("RGB", (200, 40), color="white")
draw = ImageDraw.Draw(img)
draw.text((10, 10), "Label", fill="black")
img.save(label_image_path)

data = [
    ["ID", RLImage(str(label_image_path), width=100, height=20)],
    ["1", "Alpha"],
    ["2", ""],
]
table = Table(data, colWidths=[100, 150])
table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 1, colors.black)]))

styles = getSampleStyleSheet()
doc = SimpleDocTemplate(str(out_path), pagesize=letter)
doc.build([Paragraph("1 Overview", styles["BodyText"]), table])

label_image_path.unlink()
print(f"wrote {out_path}")
