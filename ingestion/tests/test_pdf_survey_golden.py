# Task 4 (docs/superpowers/sdd/2026-08-13-pdf-ingestion-fidelity): golden-
# fixture regression coverage for Tasks 2-3's real PDF segmentation/heading
# behavior flowing all the way through to SURVEY-mode tree building.
#
# Neither pre-existing golden-fixture file covers this: tests/test_survey_golden.py
# exercises build_survey_requirements (an older, unrelated function, not
# build_survey_tree); tests/test_fidelity_golden.py exercises build_baseline_tree
# in BASELINE mode, not SURVEY branch/token-estimate stability (confirmed by
# reading both files in full). Tasks 2-3 replaced PDF's old one-page-blob
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


class FakeSectionAnalysisClient:
    """Local hand-written test double for SectionAnalysisClient -- NOT
    cross-imported from tests/test_llm_leveling.py or
    tests/test_worktree_schema_conformance.py, following this repo's own
    established convention (both of those files define their own local
    copy rather than importing a test-only class across files). Nodes'
    title/text deliberately echo this file's own fixture content (see
    _build_pdf below) so build_survey_tree's grounding/dropped-blocks
    integrity checks pass cleanly -- this test's concern is branch/node
    structural stability driven by real PDF segmentation, not integrity
    warnings, which would otherwise be noise unrelated to what Tasks 2-3
    can regress."""

    def __init__(self, nodes: list[dict]) -> None:
        self._nodes = nodes
        self.calls: list[dict] = []

    def analyze_section_skeleton(
        self, section_text: str, kb_context: str | None = None, whole_document: bool = False,
        topic_count: int | None = None, table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None, requirement_row_hints: list[tuple[str, str]] | None = None,
        heading_type_hints: list[tuple[str, str]] | None = None,
    ) -> tuple[list[dict], bool]:
        self.calls.append(
            {
                "section_text": section_text,
                "kb_context": kb_context,
                "whole_document": whole_document,
                "topic_count": topic_count,
                "table_group_hints": table_group_hints,
                "expected_root_count": expected_root_count,
            }
        )
        # STAGE 1 sees structure only -- see llm_leveling's
        # _build_survey_skeleton_for_branch.
        return [
            {k: v for k, v in node.items() if k in {"temp_id", "type", "parent_temp_id", "title"}}
            for node in self._nodes
        ], False

    def author_content(
        self, section_text: str, skeleton_nodes: dict[str, dict], kb_context: str | None = None,
    ) -> tuple[dict[str, dict], bool]:
        by_title = {node["title"]: node for node in self._nodes}
        return {
            local_id: {
                "description": by_title[info["title"]]["text"],
                "tags": by_title[info["title"]].get("tags", []),
            }
            for local_id, info in skeleton_nodes.items()
            if info["title"] in by_title
        }, False

    def analyze_section_skeleton_agentic(self, section_text: str, retrieve_fn, **kwargs) -> tuple[list[dict], list[dict], bool]:
        raise AssertionError("not exercised by this test -- default model is not tool-capable")


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
    assert not any("REV" in b.text for b in doc.blocks if b.kind == BlockKind.PARAGRAPH)  # header suppressed
    assert len(doc.blocks) == 4  # 2 HEADING + 2 PARAGRAPH (wrapped body merged to ONE block each)
    assert doc.blocks[1].kind == BlockKind.PARAGRAPH
    assert doc.blocks[1].text.count("This is a long sentence") == 3  # wrapped paragraph merged intact, not split

    # --- build_survey_tree (SURVEY branch/token-estimate stability) ---
    # Node text/title deliberately echoes the fixture's own body text so
    # grounding checks pass cleanly and tree.warnings stays empty --
    # isolates this test's real concern (structural stability) from
    # integrity-warning noise unrelated to Tasks 2-3.
    nodes = [
        {
            "temp_id": "n0", "type": "Feature", "parent_temp_id": None,
            "title": "Overview", "text": _WRAPPED_BODY_TEXT.strip(), "tags": [],
        },
        {
            "temp_id": "n1", "type": "Feature", "parent_temp_id": None,
            "title": "Scope", "text": _SCOPE_BODY_TEXT, "tags": [],
        },
    ]
    fake = FakeSectionAnalysisClient(nodes)
    tree = build_survey_tree(doc, fake)

    assert len(tree.nodes) == 2
    assert [n.type for n in tree.nodes] == [WorkItemType.FEATURE, WorkItemType.FEATURE]
    assert [n.title for n in tree.nodes] == ["Overview", "Scope"]
    assert tree.warnings == []  # no dropped-block/low-grounding regressions from segmentation changes

    # A single whole-document call, not a branch split -- this tiny
    # document's real token count comfortably fits the coverage budget.
    assert len(fake.calls) == 1
    assert fake.calls[0]["whole_document"] is True
    # topic_count is the real per-block-driven coverage hint Tasks 2-3 can
    # regress: 2 real HEADING blocks (Overview, Scope) + 0 table groups.
    # Before Task 3 added heading detection, PDF never emitted
    # BlockKind.HEADING at all, so this would have been 0 -- this
    # assertion is the concrete pin that Task 3's heading detection is
    # actually feeding build_survey_tree's coverage hint, not just
    # producing HEADING blocks nobody downstream reads.
    assert fake.calls[0]["topic_count"] == 2
    assert "REV" not in fake.calls[0]["section_text"]  # suppressed header never reaches the LLM prompt either
