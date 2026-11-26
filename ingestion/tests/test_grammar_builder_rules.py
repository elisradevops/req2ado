"""The grammar builder's rules, one by one (owner decisions, 2026-11-25): clean titles, derived marks, coded sub-items as
sub-Requirements, and a proposal applied only once the user accepted it. The whole TV twin against its gold tree is
test_tv_twin_formats.py."""

from __future__ import annotations

import sys
from functools import cache
from pathlib import Path

import pytest

from app.leveling.document_grammar import clean_heading, derived_marks
from app.leveling.tree_builder import build_baseline_tree
from app.loaders.pdf_loader import load_pdf
from app.study.model_rules import document_headings
from app.study.rulebook import DocumentRules, FileRulebook, Proposal

sys.path.insert(0, str(Path(__file__).parent / "fixtures" / "tv_twin"))
from build_tv_twin_pdf import build_twin_spec_pdf  # noqa: E402

CODES = ("aud_1", "btn_2", "men_3", "tun_1")


@pytest.mark.parametrize(
    ("heading", "title"),
    [
        ("SOFTWARE (SW_DESIGN)", "Software"),  # a code in parentheses is not part of the name
        ("TV RECEIVER", "TV receiver"),  # a capital word without a vowel is an acronym
        ("INPUTS AND CONNECTIVITY", "Inputs and connectivity"),
        ("HDMI", "HDMI"),  # printed in capitals in the running text: an acronym
        ("Safety and EMC", "Safety and EMC"),  # mixed case is the author's own
    ],
)
def test_a_heading_becomes_a_clean_title(heading: str, title: str) -> None:
    assert clean_heading(heading, frozenset({"HDMI", "EMC"})) == title


@pytest.mark.parametrize(
    ("statement", "marks"),
    [
        ("The panel shall show 3840 by 2160 pixels.", []),
        ("The menu should offer the languages listed below.", ["Should"]),
        ("The set will start within 4 s.", ["Will"]),
        ("The service life is 12 years.", ["No obligation"]),
        ("The remote shall weigh less than TBD g.", ["TBD"]),
    ],
)
def test_derived_marks_come_from_the_requirements_own_text(statement: str, marks: list[str]) -> None:
    assert derived_marks(statement) == marks


@pytest.fixture(scope="module")
def tv(tmp_path_factory):
    return _load(str(build_twin_spec_pdf(tmp_path_factory.mktemp("rules"))[0]))


@cache
def _load(path: str):
    return load_pdf(path)


def _by_cid(nodes):
    return {n.customer_id: n for n in nodes if n.customer_id}


def test_a_coded_sub_item_is_a_sub_requirement_of_its_requirement(tv) -> None:
    nodes = build_baseline_tree(tv, FileRulebook(document=DocumentRules(requirement_codes=CODES))).nodes
    by_cid = _by_cid(nodes)
    assert by_cid["men_3.a"].parent_local_id == by_cid["men_3"].local_id
    assert by_cid["men_3.b"].parent_local_id == by_cid["men_3"].local_id
    assert "men_3" not in by_cid["men_3.a"].description


def test_removing_a_level_waits_for_the_users_decision(tv) -> None:
    general = next(h["block_id"] for h in document_headings(tv) if h["number"] == "2.1")
    drop = Proposal(general, "drop_wrapper", None, "A generic name holding one section.")

    def tree(decisions: tuple) -> dict:
        rules = DocumentRules(requirement_codes=CODES, proposals=(drop,), proposal_decisions=decisions)
        return {n.title: n for n in build_baseline_tree(tv, FileRulebook(document=rules)).nodes}

    undecided, accepted = tree(()), tree(((general, "accept"),))
    assert "General" in undecided and undecided["Product family"].parent_local_id == undecided["General"].local_id
    assert "General" not in accepted and accepted["Product family"].parent_local_id == accepted["Requirements"].local_id
