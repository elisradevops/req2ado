"""Run once to (re)generate repeating_header_image.pdf and
repeating_header_image_safety_net.pdf: `python build_repeating_header_image_fixture.py`.

Reproduces a real, root-caused figure-over-segmentation bug (Gap B):
direct geometry probe against a real 53-page ICD (cubeadcs_icd.pdf) found
byte-identical small images (9.6-10.8pt tall placed size) repeating in the
page margin on most pages -- running header/footer content (a doc-id/page
marker) rendered as raster image XObjects rather than text, the same class
of artifact `_detect_boilerplate_templates` already handles for TEXT
headers/footers, never addressed for images. `repeating_header_image.pdf`
reproduces the pattern at minimal scale (10 pages, one small emblem image
repeated on every page's top margin, one real body figure appearing once)
so the fix (`_detect_boilerplate_images` in pdf_loader.py) can be proven
without needing the full real document.

`repeating_header_image_safety_net.pdf` is the over-merge safety net:
proves the fix's two gates (recurrence fraction, margin position) are each
independently required -- the same emblem repeated on only 2 of 10 pages
(below `_BOILERPLATE_RECURRENCE_FRACTION`) and a distinct image repeated on
8 of 10 pages but placed in the page BODY (outside `_HEADER_FOOTER_MARGIN_POINTS`)
must both survive.
"""
import tempfile
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

fixtures_dir = Path(__file__).parent
PAGE_W, PAGE_H = letter  # 612 x 792

with tempfile.TemporaryDirectory() as tmp_dir:
    emblem_path = Path(tmp_dir) / "emblem.png"
    PILImage.new("RGB", (20, 20), color="red").save(emblem_path)

    body_figure_path = Path(tmp_dir) / "body_figure.png"
    PILImage.new("RGB", (100, 100), color="blue").save(body_figure_path)

    body_repeat_path = Path(tmp_dir) / "body_repeat.png"
    PILImage.new("RGB", (40, 15), color="green").save(body_repeat_path)

    # Margin placement: y measured bottom-up (PDF native) -- y=770, height=10
    # puts the image's pdfplumber top-down bbox at top=12, bottom=22, both
    # comfortably inside the 72pt margin band.
    MARGIN_Y = 770.0
    MARGIN_H = 10.0
    MARGIN_X = 500.0
    MARGIN_W = 20.0

    # Body placement: y=400 puts the bbox at top=362, bottom=392 -- nowhere
    # near either margin.
    BODY_Y = 400.0
    BODY_H = 30.0
    BODY_X = 250.0
    BODY_W = 40.0

    # --- Primary fixture: emblem repeats on 9 of 10 pages; one real figure
    # once, on its own dedicated page (page 5) with NO emblem alongside it --
    # pdfplumber and pypdf do not reliably agree on image ORDER when a
    # single page has 2+ images (confirmed live against cubeadcs_icd.pdf:
    # positional pairing disagreed on 44/53 pages), a separate, already-
    # documented fragility of the existing best-effort pairing this fixture
    # deliberately does not also exercise.
    out_path = fixtures_dir / "repeating_header_image.pdf"
    c = canvas.Canvas(str(out_path), pagesize=letter)
    for page_index in range(10):
        if page_index == 4:
            c.drawImage(str(body_figure_path), 200, 500, width=100, height=100)
        else:
            c.drawImage(str(emblem_path), MARGIN_X, MARGIN_Y, width=MARGIN_W, height=MARGIN_H)
        c.showPage()
    c.save()
    print(f"wrote {out_path}")

    # --- Safety-net fixture: emblem on only 2/10 pages (below recurrence
    # fraction); a distinct image on 8/10 pages but in the BODY (below the
    # margin-position gate). Both must survive suppression. Kept on
    # disjoint pages (no page carries both images) for the same
    # single-image-per-page reason as the primary fixture above.
    safety_path = fixtures_dir / "repeating_header_image_safety_net.pdf"
    c = canvas.Canvas(str(safety_path), pagesize=letter)
    for page_index in range(10):
        if page_index < 2:
            c.drawImage(str(emblem_path), MARGIN_X, MARGIN_Y, width=MARGIN_W, height=MARGIN_H)
        else:
            c.drawImage(str(body_repeat_path), BODY_X, BODY_Y, width=BODY_W, height=BODY_H)
        c.showPage()
    c.save()
    print(f"wrote {safety_path}")
