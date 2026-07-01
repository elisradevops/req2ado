"""Run once to (re)generate hebrew_scanned_sample.pdf: `python build_hebrew_scanned_pdf_fixture.py`.

Renders Hebrew text via PIL into an image-only PDF page (no text layer),
simulating a scanned Hebrew document. Requires a Hebrew-capable TrueType
font to be available on the system running this script — on Debian/Ubuntu,
`apt-get install fonts-noto-core` provides `NotoSansHebrew` or similar; on
macOS, a system font like "Arial Unicode" or "Arial Hebrew" may work. This
script tries a list of common font paths and picks the first one that
exists; if none are found, it raises with a clear error rather than
silently rendering tofu boxes (empty glyph placeholders).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

_CANDIDATE_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansHebrew-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansHebrew-Regular.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",  # fallback; may not have full Hebrew coverage
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",  # macOS fallback for local dev
]

fixtures_dir = Path(__file__).parent
image_path = fixtures_dir / "_hebrew_scanned_page.png"
out_path = fixtures_dir / "hebrew_scanned_sample.pdf"

font_path = next((p for p in _CANDIDATE_FONT_PATHS if Path(p).exists()), None)
if font_path is None:
    raise RuntimeError(
        "No Hebrew-capable font found among candidates: "
        f"{_CANDIDATE_FONT_PATHS}. Install a Hebrew font package "
        "(e.g. `apt-get install fonts-noto-core` on Debian/Ubuntu) before running this script."
    )

font = ImageFont.truetype(font_path, size=48)
hebrew_text = "בדיקת מערכת קליטה"  # "receiver system test" — arbitrary synthetic content, not real customer data

img = Image.new("RGB", (1200, 300), color="white")
draw = ImageDraw.Draw(img)
draw.text((40, 100), hebrew_text, fill="black", font=font)
img.save(image_path)

c = canvas.Canvas(str(out_path), pagesize=letter)
c.drawImage(str(image_path), 50, 500, width=500, height=125)
c.showPage()
c.save()

image_path.unlink()
print(f"wrote {out_path} using font {font_path}")
