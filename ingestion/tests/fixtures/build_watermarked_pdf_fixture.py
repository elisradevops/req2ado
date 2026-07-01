"""Run once to (re)generate watermarked_sample.pdf: `python build_watermarked_pdf_fixture.py`.

Renders solid black body text plus a lighter gray "DRAFT" watermark-style
overlay into a single image-only PDF page, simulating a watermarked scanned
document. This is a simplified simulation (flat gray color, not a real
semi-transparent diagonal overlay) — good enough to test confidence-based
filtering behavior, not a faithful real-world watermark reproduction.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

fixtures_dir = Path(__file__).parent
image_path = fixtures_dir / "_watermarked_page.png"
out_path = fixtures_dir / "watermarked_sample.pdf"

img = Image.new("RGB", (1200, 400), color="white")
draw = ImageDraw.Draw(img)

try:
    body_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=32)
    watermark_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=80)
except OSError:
    body_font = ImageFont.load_default()
    watermark_font = ImageFont.load_default()

# Faint gray watermark, rendered first so body text draws on top (closer to real layering)
draw.text((150, 150), "DRAFT", fill=(210, 210, 210), font=watermark_font)

# Solid black body text — the real content we want preserved
draw.text((40, 40), "The receiver shall support at least 40 channels.", fill=(0, 0, 0), font=body_font)

img.save(image_path)

c = canvas.Canvas(str(out_path), pagesize=letter)
c.drawImage(str(image_path), 50, 400, width=500, height=167)
c.showPage()
c.save()

image_path.unlink()
print(f"wrote {out_path}")
