# Task 4 (docs/superpowers/sdd/2026-08-13-pdf-ingestion-fidelity): golden-
# fixture regression coverage for Tasks 2-3's real PDF segmentation/heading
# behavior flowing all the way through to SURVEY-mode tree building.
#
# No pre-existing golden-fixture file covers this: tests/test_fidelity_golden.py
# exercises build_baseline_tree in BASELINE mode, not SURVEY branch/
# token-estimate stability (confirmed by reading it in full; the other
# candidate, test_survey_golden.py, exercised a since-deleted dead code
# path -- see SWEEP.md item 1). Tasks 2-3 replaced PDF's old one-page-blob
# PARAGRAPH output with real HEADING/PARAGRAPH segmentation and header/footer
# suppression -- this changes per-block token counts and heading counts, which
# feed directly into build_survey_tree's whole-document-fits gate and its
# topic_count coverage hint (see llm_leveling.py's own §3 comments). This test
# pins REAL observed values for that path, not just "doesn't crash".
from pathlib import Path

from app.canonical.model import BlockKind
from app.leveling.llm_leveling import build_survey_tree
from app.loaders.pdf_loader import load_pdf
from app.workitem.model import WorkItemType


def _build_pdf(tmp_path: Path) -> Path:
    """Two-page synthetic PDF exercising Tasks 2+3's real PDF segmentation
    together: a running header repeated on every page ("MY DOCUMENT - REV A",
    drawn in the page margin, same mechanism
    test_load_pdf_suppresses_a_running_header_recurring_across_most_pages
    already validates at the loader level), two unnumbered top-level
    headings (font-size outlier -> synthesized number_label "1"/"2", same
    mechanism test_load_pdf_synthesizes_a_number_for_an_unnumbered_heading
    already validates), and a wrapped body paragraph under the first
    heading (same mechanism
    test_load_pdf_merges_wrapped_lines_into_one_paragraph_block already
    validates). This test's OWN concern is not any one of those in
    isolation (already covered) -- it's that all three, combined, still
    produce a stable, specific SURVEY-mode branch/node structure end to
    end."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate

    def _draw_header(canvas_obj, _doc_obj) -> None:
        canvas_obj.saveState()
        canvas_obj.setFont("Helvetica", 10)
        canvas_obj.drawString(72, 750, "MY DOCUMENT - REV A")
        canvas_obj.restoreState()

    pdf_path = tmp_path / "pdf_survey_golden.pdf"
    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(str(pdf_path), pagesize=letter)
    doc.build(
        [
            Paragraph("Overview", styles["Title"]),
            Paragraph(_WRAPPED_BODY_TEXT, styles["BodyText"]),
            PageBreak(),
            Paragraph("Scope", styles["Title"]),
            Paragraph(_SCOPE_BODY_TEXT, styles["BodyText"]),
        ],
        onFirstPage=_draw_header,
        onLaterPages=_draw_header,
    )
    return pdf_path


_WRAPPED_BODY_TEXT = (
    "This is a long sentence that must wrap across multiple lines when "
    "rendered at normal body width in a standard page layout. "
) * 3
_SCOPE_BODY_TEXT = "A second, separate section body."


def test_pdf_survey_golden_produces_stable_branch_and_heading_structure(tmp_path: Path) -> None:
    doc = load_pdf(str(_build_pdf(tmp_path)))

    # --- pdf_loader.py output (Tasks 2-3) -----------------------------
    headings = [b for b in doc.blocks if b.kind == BlockKind.HEADING]
    assert [h.number_label for h in headings] == ["1", "2"]  # pinned, not just non-empty
    assert not any(
        "REV" in b.text for b in doc.blocks if b.kind == BlockKind.PARAGRAPH
    )  # header suppressed
    assert len(doc.blocks) == 4  # 2 HEADING + 2 PARAGRAPH (wrapped body merged to ONE block each)
    assert doc.blocks[1].kind == BlockKind.PARAGRAPH
    assert (
        doc.blocks[1].text.count("This is a long sentence") == 3
    )  # wrapped paragraph merged intact, not split

    # --- build_survey_tree: the PDF's own headings are the SURVEY structure ---
    # The items are the document's own structure (code, not the model), so the heading detection above is what decides them: two
    # headings, two items, each carrying its own body, and the suppressed running header reaches no item.
    tree = build_survey_tree(doc, object())
    requirements = [n for n in tree.nodes if n.type == WorkItemType.REQUIREMENT]

    # "Scope" states no requirement ("A second, separate section body."): it is kept, word for word, in its parent's description and
    # is not an item of its own (app.leveling.informational). "Overview" says "must", so it stays a Requirement.
    assert [n.title for n in requirements] == ["Overview"]
    assert requirements[0].description.count("This is a long sentence") == 3
    assert any(_SCOPE_BODY_TEXT in (n.description or "") for n in tree.nodes if n.type != WorkItemType.REQUIREMENT)
    assert not any("REV" in (n.description or "") or "REV" in n.title for n in tree.nodes)
