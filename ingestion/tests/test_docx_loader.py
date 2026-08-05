import tempfile
from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.docx_loader import load_docx

FIXTURES = Path(__file__).parent / "fixtures"


def _build_two_section_docx_with_inline_images(tmp_path: Path) -> Path:
    # Two headings, each immediately followed by its own inline image --
    # proves each figure resolves at its OWN paragraph's real position, not
    # always the document's last position (the previous (0, 0)-placeholder
    # behavior would have folded both into whatever node was open last).
    from docx import Document as DocxDocument
    from PIL import Image

    doc = DocxDocument()
    doc.add_heading("Section One", level=1)
    doc.add_paragraph("First section body text.")
    image_one = tmp_path / "one.png"
    Image.new("RGB", (4, 4), color="red").save(image_one)
    doc.add_picture(str(image_one))
    doc.add_heading("Section Two", level=1)
    doc.add_paragraph("Second section body text.")
    image_two = tmp_path / "two.png"
    Image.new("RGB", (4, 4), color="blue").save(image_two)
    doc.add_picture(str(image_two))

    out_path = tmp_path / "two_sections.docx"
    doc.save(str(out_path))
    return out_path


def test_load_docx_extracts_heading_levels() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [(h.text, h.heading_level) for h in headings] == [
        ("Display", 1),
        ("Picture Modes", 2),
    ]


def test_load_docx_extracts_paragraphs() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    paragraphs = [b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    assert any("three picture presets" in p.text for p in paragraphs)


def test_load_docx_extracts_table_as_cell_grid() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert len(doc.tables) == 1
    assert doc.tables[0].rows == [
        ["Mode", "Description"],
        ["Vivid", "High saturation preset"],
    ]


def test_load_docx_format_is_docx() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert doc.document.format.value == "docx"


def test_load_docx_detects_embedded_image_as_figure() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    assert len(doc.figures) == 1


def test_load_docx_renders_figure_placeholder_block() -> None:
    doc = load_docx(str(FIXTURES / "sample.docx"))
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1
    assert figure_blocks[0].text == "[FIGURE: none]"


def test_load_docx_uses_describe_figure_when_provided() -> None:
    # Regression: figures previously always became an empty [FIGURE: none]
    # placeholder with no way to describe real content.
    captured_bytes: list[bytes] = []

    def fake_describe(image_bytes: bytes) -> str:
        captured_bytes.append(image_bytes)
        return "A block diagram showing power distribution."

    doc = load_docx(str(FIXTURES / "sample.docx"), describe_figure=fake_describe)

    assert len(captured_bytes) == 1
    assert len(captured_bytes[0]) > 0  # real image bytes, not empty
    assert doc.figures[0].caption == "A block diagram showing power distribution."
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert figure_blocks[0].text == "[FIGURE: A block diagram showing power distribution.]"


def test_load_docx_falls_back_to_placeholder_when_describe_figure_raises() -> None:
    # A vision failure for one image must not abort the whole document.
    def failing_describe(image_bytes: bytes) -> str:
        raise RuntimeError("vision service unreachable")

    doc = load_docx(str(FIXTURES / "sample.docx"), describe_figure=failing_describe)

    assert doc.figures[0].caption is None
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert figure_blocks[0].text == "[FIGURE: none]"


def test_load_docx_places_each_inline_figure_at_its_own_real_position() -> None:
    # Regression: every image rel was previously collected in one pass
    # AFTER the body walk, each stamped with a (0, 0) placeholder SourceRef
    # -- so in build_baseline_tree's fold (a depth=None FIGURE block always
    # attaches to whatever node is currently open), BOTH images would have
    # folded into whichever node was open LAST, regardless of which section
    # they actually appeared in. Two headings, each with its own image,
    # proves each image now lands between its own heading and the next.
    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_two_section_docx_with_inline_images(Path(tmp_dir))
        doc = load_docx(str(docx_path))

    section_one_idx = next(i for i, b in enumerate(doc.blocks) if b.text == "Section One")
    section_two_idx = next(i for i, b in enumerate(doc.blocks) if b.text == "Section Two")
    figure_indices = [i for i, b in enumerate(doc.blocks) if b.kind == BlockKind.FIGURE]

    assert len(figure_indices) == 2
    assert section_one_idx < figure_indices[0] < section_two_idx
    assert section_two_idx < figure_indices[1]
    # Neither figure carries the old (0, 0) placeholder -- both resolved a
    # real position from the shared offset counter.
    assert all(doc.blocks[i].source_ref.start_offset > 0 for i in figure_indices)


def test_load_docx_end_to_end_folds_each_figure_into_its_own_section() -> None:
    # Same fixture, run through build_baseline_tree end to end: proves the
    # placement fix actually changes which node each figure's Description
    # ends up in, not just the block ordering in isolation. A real caption
    # is supplied (describe_figure) because a placeholder-only figure is
    # now omitted from the description entirely (see tree_builder.py's
    # _figure_line) -- a caption is required to observe where it folds.
    from app.leveling.tree_builder import build_baseline_tree

    with tempfile.TemporaryDirectory() as tmp_dir:
        docx_path = _build_two_section_docx_with_inline_images(Path(tmp_dir))
        doc = load_docx(str(docx_path), describe_figure=lambda _bytes: "diagram")

    tree = build_baseline_tree(doc)
    section_one = next(n for n in tree.nodes if n.title == "Section One")
    section_two = next(n for n in tree.nodes if n.title == "Section Two")

    assert "> Figure: diagram" in section_one.description
    assert "> Figure: diagram" in section_two.description
    # Each section's own figure did NOT leak into the other section.
    assert section_one.description.count("> Figure:") == 1
    assert section_two.description.count("> Figure:") == 1
