from pathlib import Path

from app.canonical.model import BlockKind
from app.loaders.pdf_loader import load_pdf, page_has_extractable_text

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_pdf_extracts_text_blocks_with_page_number() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert len(doc.blocks) >= 1
    assert all(b.source_ref.page == 1 for b in doc.blocks)
    assert any("Backplane Power Budget" in b.text for b in doc.blocks)
    assert any(b.kind == BlockKind.PARAGRAPH for b in doc.blocks)


def test_load_pdf_extracts_at_least_one_table() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert len(doc.tables) >= 1
    flat = [cell for row in doc.tables[0].rows for cell in row]
    assert "3.3V" in flat


def test_load_pdf_format_is_pdf() -> None:
    doc = load_pdf(str(FIXTURES / "sample.pdf"))
    assert doc.document.format.value == "pdf"


def test_page_has_extractable_text_true_for_text_page() -> None:
    assert page_has_extractable_text(str(FIXTURES / "sample.pdf"), 0) is True


def test_load_pdf_extracts_a_figure_placeholder_block() -> None:
    # See CR5 of the corrected work plan: PDF figure/drawing extraction was
    # previously docx-only (docx_loader.py); this mirrors that behavior for
    # PDFs — detection + verbatim placeholder, no OCR of the image content.
    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"))
    assert len(doc.figures) == 1
    assert doc.figures[0].caption is None
    figure_blocks = [b for b in doc.blocks if b.kind == BlockKind.FIGURE]
    assert len(figure_blocks) == 1
    assert figure_blocks[0].text == "[FIGURE: none]"


def test_load_pdf_figure_placeholder_survives_into_baseline_tree_verbatim() -> None:
    from app.leveling.tree_builder import build_baseline_tree
    from app.workitem.fidelity import verify_fidelity

    doc = load_pdf(str(FIXTURES / "pdf_with_figure.pdf"))
    tree = build_baseline_tree(doc)
    assert any("[FIGURE: none]" in node.description for node in tree.nodes)
    for node in tree.nodes:
        assert verify_fidelity(node)
