"""Run once to (re)generate sample.pdf: `python build_pdf_fixture.py`."""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate
from reportlab.platypus import Table as RLTable
from reportlab.platypus import TableStyle

out_path = Path(__file__).parent / "sample.pdf"
styles = getSampleStyleSheet()
doc = SimpleDocTemplate(str(out_path), pagesize=letter)

table_style = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])

elements = [
    Paragraph("Backplane Power Budget", styles["Title"]),
    Paragraph("The backplane shall supply a minimum of 150W total.", styles["BodyText"]),
    RLTable(
        [["Rail", "Voltage", "Max Current"], ["3.3V", "3.3", "10A"], ["12V", "12", "5A"]],
        style=table_style,
    ),
]
doc.build(elements)
print(f"wrote {out_path}")
