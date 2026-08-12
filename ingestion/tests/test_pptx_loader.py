from pathlib import Path

from pptx import Presentation
from pptx.util import Inches

from app.canonical.model import BlockKind
from app.loaders.pptx_loader import load_pptx


def _build_pptx(tmp_path: Path) -> str:
    presentation = Presentation()
    title_layout = presentation.slide_layouts[1]  # "Title and Content"

    slide1 = presentation.slides.add_slide(title_layout)
    slide1.shapes.title.text = "Power Budget"
    body = slide1.placeholders[1]
    body.text_frame.text = "The system shall not exceed 500W."
    body.text_frame.add_paragraph().text = "The power supply shall support hot-swap."
    slide1.notes_slide.notes_text_frame.text = "Reviewed with the electrical lead."

    slide2 = presentation.slides.add_slide(title_layout)
    slide2.shapes.title.text = "Thermal Requirements"
    slide2.placeholders[1].text_frame.text = "The enclosure shall stay below 70C under full load."

    path = tmp_path / "sample.pptx"
    presentation.save(str(path))
    return str(path)


def test_load_pptx_produces_heading_per_slide_title(tmp_path: Path) -> None:
    doc = load_pptx(_build_pptx(tmp_path))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [h.text for h in headings] == ["Power Budget", "Thermal Requirements"]
    assert all(h.heading_level == 1 for h in headings)


def test_load_pptx_produces_paragraph_per_bullet(tmp_path: Path) -> None:
    doc = load_pptx(_build_pptx(tmp_path))
    paragraphs = [b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    texts = [p.text for p in paragraphs]
    assert "The system shall not exceed 500W." in texts
    assert "The power supply shall support hot-swap." in texts
    assert "The enclosure shall stay below 70C under full load." in texts


def test_load_pptx_produces_note_block_for_speaker_notes(tmp_path: Path) -> None:
    doc = load_pptx(_build_pptx(tmp_path))
    notes = [b for b in doc.blocks if b.kind == BlockKind.NOTE]
    assert len(notes) == 1
    assert notes[0].text == "Reviewed with the electrical lead."


def test_load_pptx_format_is_pptx(tmp_path: Path) -> None:
    doc = load_pptx(_build_pptx(tmp_path))
    assert doc.document.format.value == "pptx"


def test_load_pptx_blocks_are_in_slide_order(tmp_path: Path) -> None:
    doc = load_pptx(_build_pptx(tmp_path))
    offsets = [b.source_ref.start_offset for b in doc.blocks]
    assert offsets == sorted(offsets)


def test_load_pptx_sets_1_based_slide_number_as_page_for_every_block(tmp_path: Path) -> None:
    # Slide 1: title + 2 bullets + notes; slide 2: title + 1 bullet.
    doc = load_pptx(_build_pptx(tmp_path))
    slide1_blocks = doc.blocks[:4]
    slide2_blocks = doc.blocks[4:]
    assert all(b.source_ref.page == 1 for b in slide1_blocks)
    assert all(b.source_ref.page == 2 for b in slide2_blocks)


def test_load_pptx_captions_embedded_pictures(tmp_path: Path) -> None:
    from io import BytesIO

    from PIL import Image

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])  # blank layout
    image_buffer = BytesIO()
    Image.new("RGB", (10, 10), color="red").save(image_buffer, format="PNG")
    image_buffer.seek(0)
    slide.shapes.add_picture(image_buffer, Inches(1), Inches(1))
    path = tmp_path / "with_picture.pptx"
    presentation.save(str(path))

    calls = []

    def fake_describe_figure(image_bytes: bytes) -> str:
        calls.append(image_bytes)
        return "a red square"

    doc = load_pptx(str(path), describe_figure=fake_describe_figure)
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1
    assert figure_blocks[0].text == "[FIGURE: a red square]"
    assert len(doc.figures) == 1
    assert doc.figures[0].caption == "a red square"
    assert len(calls) == 1
    # Single blank slide -> slide 1; a figure must carry the same
    # slide-number page as any text block would have on that slide.
    assert figure_blocks[0].source_ref.page == 1
    assert doc.figures[0].source_ref.page == 1


def _order_key(source_ref) -> tuple[int, int]:
    """Local stand-in for tree_builder._order_key (owned by other in-flight
    work, not imported here): document-order sort key of (page or 0,
    start_offset), used below to confirm pptx figures no longer cluster at
    the front of the whole deck via a hardcoded (0, 0) placeholder."""
    return (source_ref.page or 0, source_ref.start_offset)


def test_load_pptx_figure_orders_within_its_own_slide_not_at_deck_front(tmp_path: Path) -> None:
    from io import BytesIO

    from PIL import Image

    presentation = Presentation()
    title_layout = presentation.slide_layouts[1]

    slide1 = presentation.slides.add_slide(title_layout)
    slide1.shapes.title.text = "Power Budget"
    slide1.placeholders[1].text_frame.text = "The system shall not exceed 500W."

    slide2 = presentation.slides.add_slide(title_layout)
    slide2.shapes.title.text = "Thermal Requirements"
    slide2.placeholders[1].text_frame.text = "The enclosure shall stay below 70C under full load."
    image_buffer = BytesIO()
    Image.new("RGB", (10, 10), color="red").save(image_buffer, format="PNG")
    image_buffer.seek(0)
    slide2.shapes.add_picture(image_buffer, Inches(1), Inches(1))

    path = tmp_path / "mixed.pptx"
    presentation.save(str(path))

    doc = load_pptx(str(path))
    all_source_refs = [b.source_ref for b in doc.blocks] + [f.source_ref for f in doc.figures]
    sorted_refs = sorted(all_source_refs, key=_order_key)

    # The figure lives on slide 2, after slide 1's content -- it must NOT
    # sort to the front of the deck the way a hardcoded (0, 0)/page=None
    # placeholder would have forced it to.
    figure_ref = next(f.source_ref for f in doc.figures)
    assert sorted_refs.index(figure_ref) > 0
    assert [_order_key(r)[0] for r in sorted_refs] == sorted(_order_key(r)[0] for r in sorted_refs)
