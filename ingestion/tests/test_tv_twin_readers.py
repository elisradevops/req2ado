"""The readers give the TV twin's builder what the document states, in every format:

- PDF: a stamp printed at a tilt over the cover (a rubber stamp, a diagonal watermark) is a marking, not text: the cover title it overlaps
  reads whole, and the stamp's words are nowhere in the document. Text turned a quarter (a margin notice, a vertical table heading) is
  not a stamp and is handled as before.
- DOCX: headings numbered by Word itself (a multilevel list linked to the heading styles, so the numbers are not typed in the text) reach
  the document grammar the same way typed numbers do."""

from __future__ import annotations

import sys
from functools import cache
from pathlib import Path

import pytest

from app.leveling.document_grammar import learn_grammar
from app.loaders.docx_loader import load_docx
from app.loaders.pdf_loader import load_pdf
from app.study.model_rules import cover_lines

TV_TWIN = Path(__file__).parent / "fixtures" / "tv_twin"
sys.path.insert(0, str(TV_TWIN))
from build_tv_twin_docx import build_tv_twin_docx  # noqa: E402
from build_tv_twin_pdf import build_twin_spec_pdf  # noqa: E402


@pytest.fixture(scope="module")
def tmp_root(tmp_path_factory) -> str:
    return str(tmp_path_factory.mktemp("tv_readers"))


@cache
def _pdf(tmp_root: str):
    return load_pdf(str(build_twin_spec_pdf(Path(tmp_root))[0]))


@cache
def _docx(tmp_root: str):
    return load_docx(str(build_tv_twin_docx(Path(tmp_root))[0]))


def test_the_cover_title_reads_whole_beside_a_tilted_stamp(tmp_root: str) -> None:
    texts = [line["text"] for line in cover_lines(_pdf(tmp_root))]
    assert "SYSTEM SPECIFICATION" in texts
    assert any(t.replace(" ", "").startswith("[220.3]VireoTelevision") for t in texts), texts


def test_the_stamps_words_are_nowhere_in_the_document(tmp_root: str) -> None:
    text = " ".join(b.text for b in _pdf(tmp_root).blocks)
    assert "Do not copy" not in text and "HALVAR ELECTRONICS LTD" not in text
    assert "COMPANY CONFIDENTIAL" in text  # the cover's own printed marking is upright text: the reader keeps it, the study decides


def test_word_numbered_headings_reach_the_document_grammar(tmp_root: str) -> None:
    grammar = learn_grammar(_docx(tmp_root))
    assert grammar is not None
    assert grammar.code.opens("btn_2 The volume shall rise by one step.") and "Satisfies" in grammar.part_labels


def test_a_note_set_at_the_margin_after_an_indented_trace_is_its_own_paragraph(tmp_root: str) -> None:
    blocks = _pdf(tmp_root).blocks
    assert not [b.text[:60] for b in blocks if "Satisfies:" in b.text and "Note:" in b.text]
    assert sum(1 for b in blocks if b.text.startswith("Note:")) == 6


def test_a_heading_whose_bookmark_points_to_the_page_before_is_still_a_heading(tmp_root: str) -> None:
    """The bookmark of "2.3.2.2 Bluetooth pairing" is set at the foot of the page before the one its heading opens."""
    heading = next(b for b in _pdf(tmp_root).blocks if b.text == "2.3.2.2 Bluetooth pairing")
    assert heading.kind.value == "heading" and heading.heading_level == 4


def test_items_word_bullets_through_their_style_are_list_items(tmp_root: str) -> None:
    items = [b for b in _docx(tmp_root).blocks if b.text in ("Home;", "Back;", "Guide;")]
    assert len(items) == 3 and all(b.kind.value == "list_item" for b in items)
