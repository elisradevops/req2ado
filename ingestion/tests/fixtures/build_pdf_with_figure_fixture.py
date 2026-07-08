"""Run once to (re)generate pdf_with_figure.pdf: `python build_pdf_with_figure_fixture.py`.

A PDF with an embedded image, for testing pdf_loader.py's figure/drawing
detection (mirrors docx_loader.py's existing Figure handling, extended to
PDF — see CR5 of the corrected work plan: "documents with drawings" in the
original request was previously docx-only)."""
import tempfile
from pathlib import Path

from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.platypus import Image as RLImage
from reportlab.platypus import Paragraph, SimpleDocTemplate
from reportlab.lib.styles import getSampleStyleSheet

out_path = Path(__file__).parent / "pdf_with_figure.pdf"
styles = getSampleStyleSheet()
doc = SimpleDocTemplate(str(out_path), pagesize=letter)

with tempfile.TemporaryDirectory() as tmp_dir:
    image_path = Path(tmp_dir) / "synthetic.png"
    Image.new("RGB", (10, 10), color="blue").save(image_path)

    elements = [
        Paragraph("Panel Layout", styles["Title"]),
        Paragraph("See the diagram below for panel layout.", styles["BodyText"]),
        RLImage(str(image_path), width=100, height=100),
    ]
    doc.build(elements)

print(f"wrote {out_path}")
