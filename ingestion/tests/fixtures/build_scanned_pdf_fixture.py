"""Run once to (re)generate scanned_sample.pdf: `python build_scanned_pdf_fixture.py`.

Produces a PDF whose single page has NO extractable text layer (an image-only
page), simulating a scanned/photographed document, so the OCR fallback path
can be exercised without needing a real scanner.
"""
from pathlib import Path

from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

fixtures_dir = Path(__file__).parent
image_path = fixtures_dir / "_scanned_page.png"
out_path = fixtures_dir / "scanned_sample.pdf"

img = Image.new("RGB", (1200, 400), color="white")
draw = ImageDraw.Draw(img)
draw.text((40, 40), "OPEN: confirm connector part number before release", fill="black")
img.save(image_path)

c = canvas.Canvas(str(out_path), pagesize=letter)
c.drawImage(str(image_path), 50, 500, width=500, height=167)
c.showPage()
c.save()

image_path.unlink()
print(f"wrote {out_path}")
