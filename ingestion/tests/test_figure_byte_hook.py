# ingestion/tests/test_figure_byte_hook.py
"""`on_figure_bytes` -- the BASELINE-safe sibling of `describe_figure`: it
hands every figure's bytes to the caller, at the same point and in the same
order, WITHOUT switching the loaders into their "vision wired up" mode (which
would change the verbatim block text)."""

import io
from pathlib import Path

from PIL import Image

from app.loaders.docx_loader import load_docx
from app.loaders.pdf_loader import load_pdf

FIXTURES = Path(__file__).parent / "fixtures"


def _captioned_docx(tmp_path: Path) -> Path:
    from docx import Document as DocxDocument

    doc = DocxDocument()
    for index, color in enumerate(("green", "red")):
        image_path = tmp_path / f"diagram{index}.png"
        Image.new("RGB", (20, 20), color=color).save(image_path)
        doc.add_picture(str(image_path))
        caption = doc.add_paragraph(f"Figure {index + 1}: Power distribution {index}.")
        caption.style = doc.styles["Caption"]
    out_path = tmp_path / "captioned.docx"
    doc.save(str(out_path))
    return out_path


def _captioned_pdf(tmp_path: Path) -> Path:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Image as RLImage
    from reportlab.platypus import Paragraph, SimpleDocTemplate

    styles = getSampleStyleSheet()
    image_path = tmp_path / "synthetic.png"
    Image.new("RGB", (10, 10), color="blue").save(image_path)
    out_path = tmp_path / "captioned.pdf"
    SimpleDocTemplate(str(out_path), pagesize=letter).build(
        [
            Paragraph("Panel Layout", styles["Title"]),
            Paragraph("See the diagram below for panel layout.", styles["BodyText"]),
            RLImage(str(image_path), width=100, height=100),
            Paragraph("Figure 1: Panel Layout Diagram", styles["BodyText"]),
        ]
    )
    return out_path


def _block_dump(doc) -> list[tuple[str, str, str]]:
    return [(block.id, block.kind.value, block.text) for block in doc.blocks]


def test_baseline_block_text_is_identical_with_and_without_the_byte_hook_docx(tmp_path) -> None:
    path = str(_captioned_docx(tmp_path))
    plain = load_docx(path)
    collected: list[bytes] = []
    hooked = load_docx(path, on_figure_bytes=collected.append)

    assert len(collected) == 2
    assert _block_dump(hooked) == _block_dump(plain)
    assert [f.model_dump() for f in hooked.figures] == [f.model_dump() for f in plain.figures]
    # The author's caption still reaches the block text (the verbatim trap).
    assert any("Power distribution 0" in text for _, _, text in _block_dump(hooked))


def test_baseline_block_text_is_identical_with_and_without_the_byte_hook_pdf(tmp_path) -> None:
    path = str(_captioned_pdf(tmp_path))
    plain = load_pdf(path)
    collected: list[bytes] = []
    hooked = load_pdf(path, on_figure_bytes=collected.append)

    assert len(collected) == 1
    assert _block_dump(hooked) == _block_dump(plain)
    assert [f.model_dump() for f in hooked.figures] == [f.model_dump() for f in plain.figures]
    assert any("Panel Layout Diagram" in text for _, _, text in _block_dump(hooked))


def test_byte_hook_runs_once_per_emitted_figure_in_figure_order_docx() -> None:
    collected: list[bytes] = []
    doc = load_docx(str(FIXTURES / "multi_figure.docx"), on_figure_bytes=collected.append)
    assert len(collected) == len(doc.figures) == 2
    assert all(Image.open(io.BytesIO(data)).size for data in collected)


def test_byte_hook_fires_for_pptx_and_image_loaders() -> None:
    from app.loaders.image_loader import load_image
    from app.loaders.pptx_loader import load_pptx

    image_bytes: list[bytes] = []
    load_image(str(FIXTURES / "sample.png"), on_figure_bytes=image_bytes.append)
    assert image_bytes == [(FIXTURES / "sample.png").read_bytes()]

    pptx_bytes: list[bytes] = []
    doc = load_pptx(str(FIXTURES / "sample.pptx"), on_figure_bytes=pptx_bytes.append)
    assert len(pptx_bytes) == len(doc.figures)


def test_byte_hook_failure_never_aborts_the_load() -> None:
    def exploding(_: bytes) -> None:
        raise RuntimeError("boom")

    doc = load_docx(str(FIXTURES / "multi_figure.docx"), on_figure_bytes=exploding)
    assert len(doc.figures) == 2
