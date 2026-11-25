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
