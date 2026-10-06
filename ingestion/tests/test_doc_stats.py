import re
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
)
from app.canonical.stats import compute_doc_stats, count_words
from app.dispatch import dispatch_by_extension

FIXTURES = Path(__file__).parent / "fixtures"


def _ref(page: int | None = None) -> SourceRef:
    return SourceRef(document_path="d", start_offset=0, end_offset=0, page=page)


def _doc(blocks=(), tables=(), figures=()) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="d", format=DocumentFormat.TXT, sha256="x"),
        blocks=list(blocks),
        tables=list(tables),
        figures=list(figures),
    )


def _block(i: int, kind: BlockKind, text: str, page: int | None = None) -> Block:
    return Block(id=f"b{i}", kind=kind, text=text, source_ref=_ref(page))


def test_count_words_splits_on_whitespace() -> None:
    assert count_words("The BP shall provide 28 V DC.") == 7


def test_count_words_handles_empty_and_blank() -> None:
    assert count_words("") == 0
    assert count_words("   \n\t ") == 0


def test_count_words_hebrew_matches_a_word_reference_within_two_percent() -> None:
    # Spike D: Hebrew is whitespace-delimited, so a plain split must agree
    # with an independent \w+ tokenizer on realistic requirement prose.
    text = (
        "המערכת תספק מתח של 28 וולט למחבר J3. "
        "אות הסנכרון יהיה דיפרנציאלי, 100 אוהם, ויסתיים במקלט. "
        "כל מסגרת טלמטריה תכלול מונה מסגרות עולה וסכום ביקורת."
    )
    reference = len(re.findall(r"\w+", text))
    assert abs(count_words(text) - reference) / reference <= 0.02


def test_count_words_counts_spaceless_scripts_per_character() -> None:
    assert count_words("日本語のテスト") == 7
    assert count_words("시스템은 28V를 공급한다") >= 8


def test_count_words_mixed_latin_and_cjk() -> None:
    # 2 latin tokens + 4 ideographs
    assert count_words("connector J3 接口定义") == 2 + 4


def test_stats_excludes_table_and_figure_block_text_and_counts_cells_once() -> None:
    cell = TableCell(text="Bus voltage 28 V")
    table = Table(
        id="t1",
        cells=[[cell, None], [TableCell(text="Ripple"), TableCell(text="50 mV")]],
        source_ref=_ref(3),
    )
    doc = _doc(
        blocks=[
            _block(1, BlockKind.HEADING, "1 Power interfaces", page=1),
            _block(2, BlockKind.PARAGRAPH, "The BP shall provide power.", page=2),
            _block(3, BlockKind.TABLE, "Bus voltage 28 V Ripple 50 mV", page=3),
            _block(4, BlockKind.FIGURE, "Figure 1 caption text", page=3),
        ],
        tables=[table],
        figures=[Figure(id="f1", caption="vision caption", source_ref=_ref(4))],
    )
    stats = compute_doc_stats(doc)
    assert stats.words == 3 + 5 + (4 + 1 + 2)  # heading + paragraph + the three non-empty cells
    assert stats.blocks == 4
    assert stats.headings == 1
    assert stats.tables == 1
    assert stats.table_rows == 2
    assert stats.figures == 1
    assert stats.pages == 4


def test_stats_pages_is_none_without_pagination() -> None:
    stats = compute_doc_stats(_doc(blocks=[_block(1, BlockKind.PARAGRAPH, "hello world")]))
    assert stats.pages is None
    assert stats.words == 2


def test_stats_of_an_empty_document_is_all_zero() -> None:
    stats = compute_doc_stats(_doc())
    counts = (stats.words, stats.blocks, stats.headings)
    counts += (stats.tables, stats.table_rows, stats.figures)
    assert counts == (0, 0, 0, 0, 0, 0)
    assert stats.pages is None


@pytest.mark.parametrize(
    "filename",
    [
        "sample.txt", "sample.md", "sample.docx", "sample.xlsx", "sample.csv",
        "sample.pdf", "sample.pptx", "sample.rtf", "mock_icd.docx",
    ],
)
def test_stats_of_every_supported_loader_are_consistent(filename: str) -> None:
    doc = dispatch_by_extension(filename, str(FIXTURES / filename))
    stats = compute_doc_stats(doc)
    assert stats.words > 0
    assert stats.blocks == len(doc.blocks)
    assert stats.tables == len(doc.tables)
    assert stats.figures == len(doc.figures)
    assert 0 <= stats.headings <= stats.blocks
    assert stats.table_rows == sum(len(t.cells) for t in doc.tables)


def test_stats_of_plain_text_matches_a_whitespace_reference() -> None:
    raw = (FIXTURES / "sample.txt").read_text(encoding="utf-8")
    doc = dispatch_by_extension("sample.txt", str(FIXTURES / "sample.txt"))
    reference = len(raw.split())
    assert abs(compute_doc_stats(doc).words - reference) <= max(2, round(0.02 * reference))


def test_stats_of_a_spreadsheet_count_its_rows() -> None:
    doc = dispatch_by_extension("sample.xlsx", str(FIXTURES / "sample.xlsx"))
    stats = compute_doc_stats(doc)
    assert stats.tables >= 1
    assert stats.table_rows >= 2
