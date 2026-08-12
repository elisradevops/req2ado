import shutil
import subprocess
from pathlib import Path

import pytest

from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    Document,
    DocumentFormat,
    Figure,
    SourceRef,
    Table,
    TableCell,
    plain_text_rows,
)
from app.leveling.tree_builder import _hash_identity, _order_key
from app.loaders.docx_loader import load_docx
from app.loaders.docx_pagination import (
    PageAlignment,
    annotate_docx_pages,
    annotate_pages_from_pdf,
    convert_docx_to_pdf,
)
from app.loaders.pdf_loader import load_pdf

FIXTURES = Path(__file__).parent / "fixtures"


def _docx_sr(path: str, start: int, end: int) -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end)


def _docx_doc(blocks: list[Block], tables: list[Table] | None = None, figures: list[Figure] | None = None) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="input.docx", format=DocumentFormat.DOCX, sha256="h"),
        blocks=blocks,
        tables=tables or [],
        figures=figures or [],
    )


def _pdf_doc(page_texts: dict[int, list[str]]) -> CanonicalDoc:
    """Builds a synthetic pdf_doc the SAME shape pdf_loader.load_pdf would
    produce -- one Block per paragraph, real page numbers, in page order --
    without touching a real PDF file. Used by every pure-function test
    below (annotate_pages_from_pdf takes no I/O)."""
    blocks: list[Block] = []
    counter = 0
    for page in sorted(page_texts):
        for text in page_texts[page]:
            blocks.append(
                Block(
                    id=f"pb{counter}", kind=BlockKind.PARAGRAPH, text=text,
                    source_ref=SourceRef(document_path="converted.pdf", start_offset=0, end_offset=len(text), page=page),
                )
            )
            counter += 1
    return CanonicalDoc(document=Document(path="converted.pdf", format=DocumentFormat.PDF, sha256="h"), blocks=blocks)


# ---------------------------------------------------------------------------
# annotate_pages_from_pdf -- pure-function tests (no I/O)
# ---------------------------------------------------------------------------


def test_exact_anchor_match_assigns_the_real_page() -> None:
    doc = _docx_doc(
        [Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46))]
    )
    pdf_doc = _pdf_doc({1: ["Some unrelated front matter."], 2: ["The backplane shall supply continuous power."]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[0].source_ref.page == 2
    assert doc.blocks[0].source_ref.page_end == 2
    assert doc.blocks[0].source_ref.page_provenance is None  # exact match, full confidence


def test_ligature_nbsp_and_smart_quote_normalization_still_matches() -> None:
    # PDF extraction commonly returns a ligature as one codepoint ("ﬁ"),
    # curly smart quotes instead of straight ones, and a non-breaking space
    # instead of a normal one -- none of that should prevent a real match.
    docx_text = "The backplane shall not sacrifice ‘efficiency’ for cost."
    pdf_text = "The backplane shall not sacrifice ‘eﬃciency’ for cost."
    doc = _docx_doc([Block(id="b0", kind=BlockKind.PARAGRAPH, text=docx_text, source_ref=_docx_sr("input.docx", 0, len(docx_text)))])
    pdf_doc = _pdf_doc({1: [pdf_text]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[0].source_ref.page == 1


def test_a_block_spanning_a_real_page_break_gets_page_end_greater_than_page() -> None:
    doc = _docx_doc(
        [Block(id="b0", kind=BlockKind.PARAGRAPH, text="charlie delta", source_ref=_docx_sr("input.docx", 0, 13))]
    )
    # "charlie" is the tail of page 1's own paragraph, "delta" is the head
    # of page 2's -- the SAME logical content the docx renders as one
    # paragraph got split across a page boundary by the PDF's own layout.
    pdf_doc = _pdf_doc({1: ["alpha bravo charlie"], 2: ["delta echo foxtrot"]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[0].source_ref.page == 1
    assert doc.blocks[0].source_ref.page_end == 2


def test_unanchored_block_bracketed_by_same_page_anchors_gets_that_page() -> None:
    doc = _docx_doc(
        [
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Notes:", source_ref=_docx_sr("input.docx", 47, 53)),  # too short to anchor
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="Every downstream rail shall be independently fused.", source_ref=_docx_sr("input.docx", 54, 106)),
        ]
    )
    pdf_doc = _pdf_doc({1: ["The backplane shall supply continuous power. Every downstream rail shall be independently fused."]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[1].source_ref.page == 1
    assert doc.blocks[1].source_ref.page_end == 1
    assert doc.blocks[1].source_ref.page_provenance == "interpolated"


def test_unanchored_block_bracketed_by_different_page_anchors_gets_an_honest_range() -> None:
    doc = _docx_doc(
        [
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Notes:", source_ref=_docx_sr("input.docx", 47, 53)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="Every downstream rail shall be independently fused.", source_ref=_docx_sr("input.docx", 54, 106)),
        ]
    )
    pdf_doc = _pdf_doc(
        {1: ["The backplane shall supply continuous power."], 2: ["Every downstream rail shall be independently fused."]}
    )
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[1].source_ref.page == 1
    assert doc.blocks[1].source_ref.page_end == 2
    assert doc.blocks[1].source_ref.page_provenance == "interpolated"


def test_content_before_the_first_anchor_extrapolates_to_page_one() -> None:
    doc = _docx_doc(
        [
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Cover", source_ref=_docx_sr("input.docx", 0, 5)),  # too short to anchor
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 6, 52)),
        ]
    )
    pdf_doc = _pdf_doc({1: ["Some front matter."], 3: ["The backplane shall supply continuous power."]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[0].source_ref.page == 1
    assert doc.blocks[0].source_ref.page_end == 3
    assert doc.blocks[0].source_ref.page_provenance == "interpolated"


def test_content_after_the_last_anchor_extrapolates_to_the_final_page() -> None:
    doc = _docx_doc(
        [
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="End", source_ref=_docx_sr("input.docx", 47, 50)),  # too short to anchor
        ]
    )
    pdf_doc = _pdf_doc({1: ["The backplane shall supply continuous power."], 2: ["Trailing appendix content."], 5: ["Final page filler content."]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[1].source_ref.page == 1
    assert doc.blocks[1].source_ref.page_end == 5
    assert doc.blocks[1].source_ref.page_provenance == "interpolated"


def test_ratio_gate_discards_the_whole_alignment_on_a_bad_conversion() -> None:
    # The docx and "converted" PDF share almost no real text at all --
    # simulates a silent soffice failure / pathological conversion.
    doc = _docx_doc(
        [
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Every downstream rail shall be independently fused.", source_ref=_docx_sr("input.docx", 47, 99)),
        ]
    )
    pdf_doc = _pdf_doc({1: ["Completely unrelated garbled conversion output that shares nothing."]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is False
    assert alignment.anchored_ratio < 0.6
    # The other half of the invariant: a discarded alignment leaves EVERY
    # element exactly as it started, never a partial/mixed result.
    assert doc.blocks[0].source_ref.page is None
    assert doc.blocks[1].source_ref.page is None


def test_min_anchor_chars_skips_a_short_block_and_resolves_it_via_interpolation() -> None:
    doc = _docx_doc(
        [
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Scope", source_ref=_docx_sr("input.docx", 47, 52)),  # 5 chars < _MIN_ANCHOR_CHARS
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="Every downstream rail shall be independently fused.", source_ref=_docx_sr("input.docx", 53, 105)),
        ]
    )
    pdf_doc = _pdf_doc(
        {1: ["The backplane shall supply continuous power."], 2: ["Every downstream rail shall be independently fused."]}
    )
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    # "Scope" was never itself searched for (too short) -- it lands via the
    # same different-page bracket rule as the dedicated test above.
    assert doc.blocks[1].source_ref.page == 1
    assert doc.blocks[1].source_ref.page_end == 2
    assert doc.blocks[1].source_ref.page_provenance == "interpolated"


def test_placeholder_zero_zero_figure_gets_the_whole_document_range() -> None:
    # docx_loader.py's own fallback for a floating/unmatched image rel --
    # both the Figure AND its paired FIGURE-kind Block share the (0, 0)
    # placeholder SourceRef.
    figure_block = Block(id="fig_b0", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_docx_sr("input.docx", 0, 0))
    real_block = Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 1, 47))
    doc = _docx_doc(
        [figure_block, real_block],
        figures=[Figure(id="f0", caption=None, source_ref=_docx_sr("input.docx", 0, 0))],
    )
    pdf_doc = _pdf_doc({1: ["The backplane shall supply continuous power."], 2: ["More content."], 3: ["Final page."]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[0].source_ref.page == 1
    assert doc.blocks[0].source_ref.page_end == 3
    assert doc.blocks[0].source_ref.page_provenance == "interpolated"
    assert doc.figures[0].source_ref.page == 1
    assert doc.figures[0].source_ref.page_end == 3
    assert doc.figures[0].source_ref.page_provenance == "interpolated"


def test_table_gets_a_page_via_bracket_interpolation_never_anchored_directly() -> None:
    doc = _docx_doc(
        [
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Every downstream rail shall be independently fused.", source_ref=_docx_sr("input.docx", 48, 100)),
        ],
        tables=[Table(id="t0", cells=[[TableCell(text="Rail"), TableCell(text="Voltage")]], source_ref=_docx_sr("input.docx", 47, 48))],
    )
    pdf_doc = _pdf_doc(
        {1: ["The backplane shall supply continuous power."], 2: ["Every downstream rail shall be independently fused."]}
    )
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.tables[0].source_ref.page == 1
    assert doc.tables[0].source_ref.page_end == 2
    assert doc.tables[0].source_ref.page_provenance == "interpolated"


def test_ordering_by_order_key_is_identical_before_and_after_annotation() -> None:
    # Proof that adding real pages never changes relative document order --
    # every page assignment is monotonically consistent with the original
    # offset-only ordering, by construction of the anchor pass being a
    # document-order walk.
    blocks = [
        Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Power Distribution Overview", source_ref=_docx_sr("input.docx", 0, 28)),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="Short note", source_ref=_docx_sr("input.docx", 29, 39)),
        Block(id="b2", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power across every slot.", source_ref=_docx_sr("input.docx", 40, 104)),
        Block(id="b3", kind=BlockKind.PARAGRAPH, text="Every downstream rail shall be independently fused for safety.", source_ref=_docx_sr("input.docx", 106, 170)),
    ]
    table = Table(id="t0", cells=[[TableCell(text="Rail"), TableCell(text="Voltage")]], source_ref=_docx_sr("input.docx", 105, 106))
    doc = _docx_doc(blocks, tables=[table])
    ids_before = [item.id for item in sorted([*doc.blocks, *doc.tables], key=lambda item: _order_key(item.source_ref))]

    pdf_doc = _pdf_doc(
        {
            1: ["Power Distribution Overview"],
            2: ["The backplane shall supply continuous power across every slot."],
            3: ["Every downstream rail shall be independently fused for safety."],
        }
    )
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    ids_after = [item.id for item in sorted([*doc.blocks, *doc.tables], key=lambda item: _order_key(item.source_ref))]
    assert ids_after == ids_before


def test_identity_hash_is_unaffected_by_page_annotation() -> None:
    # page/page_end/page_provenance are deliberately excluded from
    # _hash_identity's input (document_path/start_offset/end_offset only)
    # -- widening/assigning them must never change a node's identity_hash,
    # or a re-run would look like a new item and duplicate-create in ADO.
    block = Block(id="b0", kind=BlockKind.PARAGRAPH, text="The backplane shall supply continuous power.", source_ref=_docx_sr("input.docx", 0, 46))
    doc = _docx_doc([block])
    hash_before = _hash_identity(block.text, block.source_ref)

    pdf_doc = _pdf_doc({1: ["Front matter."], 4: ["The backplane shall supply continuous power."]})
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment.applied is True
    assert doc.blocks[0].source_ref.page == 4  # confirms annotation actually ran
    hash_after = _hash_identity(doc.blocks[0].text, doc.blocks[0].source_ref)
    assert hash_after == hash_before


def test_annotate_pages_from_pdf_returns_unapplied_when_pdf_doc_has_no_pages_at_all() -> None:
    doc = _docx_doc([Block(id="b0", kind=BlockKind.PARAGRAPH, text="Anything at all.", source_ref=_docx_sr("input.docx", 0, 16))])
    pdf_doc = CanonicalDoc(document=Document(path="converted.pdf", format=DocumentFormat.PDF, sha256="h"))
    alignment = annotate_pages_from_pdf(doc, pdf_doc)
    assert alignment == PageAlignment(applied=False, anchored_ratio=0.0, page_count=0)
    assert doc.blocks[0].source_ref.page is None


# ---------------------------------------------------------------------------
# Real-loader integration test WITHOUT soffice (python-docx + reportlab)
# ---------------------------------------------------------------------------


def _build_matching_docx_and_hand_paginated_pdf(tmp_path: Path) -> tuple[Path, Path]:
    from docx import Document as DocxDocument
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate

    heading_text = "Power Distribution Overview"
    para1_text = "The backplane shall supply continuous power across every populated slot without interruption."
    para2_text = "Every downstream rail shall be independently fused against an overcurrent condition."

    docx_doc = DocxDocument()
    docx_doc.add_heading(heading_text, level=1)
    docx_doc.add_paragraph(para1_text)
    docx_doc.add_paragraph(para2_text)
    docx_path = tmp_path / "paged.docx"
    docx_doc.save(str(docx_path))

    styles = getSampleStyleSheet()
    pdf_path = tmp_path / "paged.pdf"
    rl_doc = SimpleDocTemplate(str(pdf_path), pagesize=letter)
    rl_doc.build(
        [
            Paragraph(heading_text, styles["Title"]),
            PageBreak(),
            Paragraph(para1_text, styles["BodyText"]),
            PageBreak(),
            Paragraph(para2_text, styles["BodyText"]),
        ]
    )
    return docx_path, pdf_path


def test_real_loader_integration_assigns_exact_expected_pages(tmp_path) -> None:
    docx_path, pdf_path = _build_matching_docx_and_hand_paginated_pdf(tmp_path)
    doc = load_docx(str(docx_path))
    pdf_doc = load_pdf(str(pdf_path), text_only=True)

    alignment = annotate_pages_from_pdf(doc, pdf_doc)

    assert alignment.applied is True
    assert alignment.page_count == 3
    heading = next(b for b in doc.blocks if b.kind == BlockKind.HEADING)
    paragraphs = [b for b in doc.blocks if b.kind == BlockKind.PARAGRAPH]
    assert heading.source_ref.page == 1
    assert paragraphs[0].source_ref.page == 2
    assert paragraphs[1].source_ref.page == 3


def test_load_pdf_text_only_skips_tables_and_figures() -> None:
    # ~10-line change to load_pdf -- confirms the opt-in flag actually
    # skips page.find_tables()/the pypdf image-enumeration pass (the
    # expensive per-page work page alignment doesn't need). No tables/
    # figures are produced at all -- page alignment only reads block text,
    # so this is a pure win, not a partial-behavior mode.
    default_doc = load_pdf(str(FIXTURES / "sample.pdf"))
    text_only_doc = load_pdf(str(FIXTURES / "sample.pdf"), text_only=True)
    assert len(default_doc.tables) >= 1
    assert text_only_doc.tables == []
    assert text_only_doc.figures == []
    assert all(b.source_ref.page == 1 for b in text_only_doc.blocks)
    # Without find_tables()'s own char-region filtering, a table's cell text
    # is no longer excised from extract_text() -- it folds into the page's
    # own paragraph text instead of staying a separate Table entry. Real
    # content (the table's own text) is never LOST, just not structured --
    # exactly what a text-only pass needs, nothing more.
    combined_text_only = " ".join(b.text for b in text_only_doc.blocks)
    for row in plain_text_rows(default_doc.tables[0]):
        for cell in row:
            assert cell in combined_text_only


# ---------------------------------------------------------------------------
# convert_docx_to_pdf -- subprocess wrapper tests (mirrors
# tests/test_emf_converter.py's own structure)
# ---------------------------------------------------------------------------


def _fake_run_writes_output(size_bytes: int):
    def fake_run(cmd, capture_output, timeout, check):
        outdir = cmd[cmd.index("--outdir") + 1]
        input_path = cmd[-1]
        stem = Path(input_path).stem
        with open(f"{outdir}/{stem}.pdf", "wb") as f:
            f.write(b"x" * size_bytes)
        return subprocess.CompletedProcess(cmd, 0)

    return fake_run


def test_convert_docx_to_pdf_returns_the_output_path_on_success(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run_writes_output(2000))
    docx_path = tmp_path / "sample.docx"
    docx_path.write_bytes(b"fake docx bytes")
    result = convert_docx_to_pdf(str(docx_path), str(tmp_path))
    assert result == str(tmp_path / "sample.pdf")


def test_convert_docx_to_pdf_returns_none_when_soffice_missing(monkeypatch, tmp_path) -> None:
    def fake_run(*args, **kwargs):
        raise FileNotFoundError("soffice not found")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert convert_docx_to_pdf(str(tmp_path / "x.docx"), str(tmp_path)) is None


def test_convert_docx_to_pdf_returns_none_on_conversion_failure(monkeypatch, tmp_path) -> None:
    def fake_run(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert convert_docx_to_pdf(str(tmp_path / "x.docx"), str(tmp_path)) is None


def test_convert_docx_to_pdf_returns_none_on_timeout(monkeypatch, tmp_path) -> None:
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="soffice", timeout=180.0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert convert_docx_to_pdf(str(tmp_path / "x.docx"), str(tmp_path)) is None


def test_convert_docx_to_pdf_returns_none_when_output_file_is_missing(monkeypatch, tmp_path) -> None:
    def fake_run(cmd, capture_output, timeout, check):
        return subprocess.CompletedProcess(cmd, 0)  # exit 0, but writes nothing

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert convert_docx_to_pdf(str(tmp_path / "x.docx"), str(tmp_path)) is None


def test_convert_docx_to_pdf_returns_none_when_output_file_is_too_small(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_run_writes_output(10))  # below _MIN_OUTPUT_FILE_BYTES
    assert convert_docx_to_pdf(str(tmp_path / "x.docx"), str(tmp_path)) is None


# ---------------------------------------------------------------------------
# annotate_docx_pages -- orchestrator (best-effort try/except wrapping)
# ---------------------------------------------------------------------------


def test_annotate_docx_pages_returns_doc_unchanged_when_conversion_fails(monkeypatch, tmp_path) -> None:
    import app.loaders.docx_pagination as docx_pagination

    monkeypatch.setattr(docx_pagination, "convert_docx_to_pdf", lambda docx_path, out_dir: None)
    doc = _docx_doc([Block(id="b0", kind=BlockKind.PARAGRAPH, text="Anything.", source_ref=_docx_sr("input.docx", 0, 9))])
    result_doc, alignment = annotate_docx_pages(doc, str(tmp_path / "whatever.docx"))
    assert result_doc is doc
    assert result_doc.blocks[0].source_ref.page is None
    assert alignment.applied is False


def test_annotate_docx_pages_never_raises_on_an_unexpected_internal_failure(monkeypatch, tmp_path) -> None:
    import app.loaders.docx_pagination as docx_pagination

    def _boom(docx_path, out_dir):
        raise RuntimeError("something pathological")

    monkeypatch.setattr(docx_pagination, "convert_docx_to_pdf", _boom)
    doc = _docx_doc([Block(id="b0", kind=BlockKind.PARAGRAPH, text="Anything.", source_ref=_docx_sr("input.docx", 0, 9))])
    result_doc, alignment = annotate_docx_pages(doc, str(tmp_path / "whatever.docx"))
    assert result_doc is doc
    assert alignment.applied is False


# ---------------------------------------------------------------------------
# Real end-to-end (skipped in CI -- no LibreOffice on a stock hosted runner)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("soffice") is None, reason="soffice (LibreOffice) is not installed")
def test_real_end_to_end_docx_to_pdf_conversion_and_alignment() -> None:
    docx_path = FIXTURES / "sample.docx"
    doc = load_docx(str(docx_path))
    result_doc, alignment = annotate_docx_pages(doc, str(docx_path))
    assert alignment.applied is True
    assert alignment.page_count >= 1
    assert all(b.source_ref.page is not None for b in result_doc.blocks)
