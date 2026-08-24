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

`repeating_header_image_multi_position.pdf` reproduces a second real bug
found live against cubeadcs_icd.pdf: the SAME emblem drawn at more than one
margin position across the document (there, a logo at three slightly
different (x0, top) coordinates). Keying recurrence detection on
(hash, x0, top) instead of hash alone splits one recurring image into
several under-threshold groups, so none individually reaches
`_BOILERPLATE_RECURRENCE_FRACTION` and the whole thing survives as if it
were several distinct figures. Here the emblem is drawn at position A on
5 of 10 pages and position B on 4 of 10 pages -- 5 and 4 are each below the
6-page (60%) threshold individually, but the combined 9/10 is well above
it. Content-hash-only keying must suppress all 9 placements; the buggy
position-sensitive keying suppresses none.
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

    # --- Multi-position fixture: the SAME emblem drawn at two different
    # margin positions, neither of which individually clears the recurrence
    # threshold (5/10 and 4/10, both < 6/10) but which together (9/10)
    # clear it easily. Both positions are comfortably inside the margin
    # band, so the margin gate is satisfied for every placement -- the only
    # question this fixture isolates is whether the recurrence key unifies
    # the two positions into one count.
    MARGIN_X_B = 100.0
    multi_path = fixtures_dir / "repeating_header_image_multi_position.pdf"
    c = canvas.Canvas(str(multi_path), pagesize=letter)
    for page_index in range(10):
        if page_index < 5:
            c.drawImage(str(emblem_path), MARGIN_X, MARGIN_Y, width=MARGIN_W, height=MARGIN_H)
        elif page_index < 9:
            c.drawImage(str(emblem_path), MARGIN_X_B, MARGIN_Y, width=MARGIN_W, height=MARGIN_H)
        # page_index == 9: no emblem at all, so total is 9/10 pages.
        c.showPage()
    c.save()
    print(f"wrote {multi_path}")

    # --- Content-dedup fixture: a diagram reused a handful of times in the
    # page BODY, on different pages -- neither boilerplate gate can ever
    # catch this (3/6 pages is below _BOILERPLATE_RECURRENCE_FRACTION, and
    # the placement is nowhere near the margin), yet it is still the same
    # image, not 3 distinct figures. Confirmed live on cubeadcs_icd.pdf: a
    # 215x212 graphic recurred on 10/53 pages (19%, far below the 60%
    # threshold) with only 4/10 placements in the margin band. Pages 0/2/4
    # all reuse one diagram; pages 1/3/5 each carry their OWN distinct
    # image, so the expected result is 4 figures (1 reused + 3 unique) from
    # 6 raw placements -- proving dedup collapses true repeats without
    # touching genuinely distinct images.
    reused_diagram_path = Path(tmp_dir) / "reused_diagram.png"
    PILImage.new("RGB", (150, 150), color="purple").save(reused_diagram_path)

    unique_figure_paths = []
    for color in ("orange", "yellow", "cyan"):
        p = Path(tmp_dir) / f"unique_{color}.png"
        PILImage.new("RGB", (150, 150), color=color).save(p)
        unique_figure_paths.append(p)

    dedup_path = fixtures_dir / "reused_body_diagram.pdf"
    c = canvas.Canvas(str(dedup_path), pagesize=letter)
    unique_index = 0
    for page_index in range(6):
        if page_index in (0, 2, 4):
            c.drawImage(str(reused_diagram_path), BODY_X, BODY_Y, width=150, height=150)
        else:
            c.drawImage(str(unique_figure_paths[unique_index]), BODY_X, BODY_Y, width=150, height=150)
            unique_index += 1
        c.showPage()
    c.save()
    print(f"wrote {dedup_path}")
