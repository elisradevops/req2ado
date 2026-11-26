"""The grammar builder's rules, one by one (owner decisions, 2026-11-25): clean titles, derived marks, coded sub-items as
sub-Requirements, proposals applied unless undone (R4), and no item without a requirement below it (R2). The whole TV twin against its gold tree is
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


def test_a_proposal_applies_unless_the_user_undoes_it(tv) -> None:
    """Owner rule R4 (2026-11-26): the study's renames and level removals apply by default; "keep" is the user's undo, before Start."""
    headings = {h["number"]: h["block_id"] for h in document_headings(tv) if h["number"]}
    drop = Proposal(headings["2.1"], "drop_wrapper", None, "A generic name holding one section.")
    rename = Proposal(headings["2"], "rename", "Vireo Television Set (VTS)", "Named after the cover.")

    def tree(decisions: tuple) -> dict:
        rules = DocumentRules(requirement_codes=CODES, proposals=(drop, rename), proposal_decisions=decisions)
        return {n.title: n for n in build_baseline_tree(tv, FileRulebook(document=rules)).nodes}

    undecided = tree(())
    assert "General" not in undecided and "Requirements" not in undecided
    assert undecided["Product family"].parent_local_id == undecided["Vireo Television Set (VTS)"].local_id
    undone = tree(((headings["2.1"], "keep"), (headings["2"], "keep")))
    assert "General" in undone and undone["Product family"].parent_local_id == undone["General"].local_id
    assert undone["General"].parent_local_id == undone["Requirements"].local_id


def _left_out_texts(tree) -> list[str]:
    return [p["text"] for w in tree.warnings if w.kind.value == "front_matter_left_out" for p in w.detail.get("parts", [])]


def test_an_empty_section_is_left_out_whatever_the_study_says(tv) -> None:
    """Owner rule R2 (2026-11-26): no Epic or Feature without a requirement below it. A section whose whole text is "None.",
    "Not applicable." or "intentionally left blank" is listed under Left out, even when the study answered "empty_feature"."""
    for treatment in ("empty_feature", "leave_out"):
        rules = DocumentRules(requirement_codes=CODES, empty_treatment=treatment)
        tree = build_baseline_tree(tv, FileRulebook(document=rules))
        titles = {n.title for n in tree.nodes}
        empty = ("Interchangeability", "Voice control", "Software reuse", "Test equipment", "Reserved")
        assert not titles & set(empty), (treatment, titles & set(empty))
        left_out = " ".join(_left_out_texts(tree)).casefold()
        assert all(t.casefold() in left_out for t in empty), (treatment, _left_out_texts(tree))


def test_no_epic_or_feature_is_left_without_a_requirement_below_it(tmp_path: Path) -> None:
    """R2 for a section that is not a marker: a numbered area with no requirement anywhere below it is never an item."""
    from app.loaders.text_loader import load_markdown

    reqs = "\n\n".join(f"REQ-{n:03d}: The unit shall perform function number {n} within {n} s." for n in range(1, 7))
    text = (
        f"# 1 Requirements\n\n## 1.1 Power\n\n{reqs}\n\n## 1.2 Future work\n\nPlanned for later.\n\n### 1.2.1 Later\n\n"
        "### 1.2.2 Also later\n\n## 1.3 Data\n\nREQ-007: The unit shall log every event.\n"
    )
    path = tmp_path / "spec.md"
    path.write_text(text, encoding="utf-8")
    nodes = build_baseline_tree(load_markdown(str(path))).nodes
    has_requirement_below = {n.parent_local_id for n in nodes if n.type.value == "Requirement"}
    changed = True
    while changed:  # every ancestor of a requirement
        parents = {n.parent_local_id for n in nodes if n.local_id in has_requirement_below} - has_requirement_below
        changed = bool(parents - {None})
        has_requirement_below |= parents
    empty = [n.title for n in nodes if n.type.value != "Requirement" and n.local_id not in has_requirement_below]
    assert not empty, empty
    # A short lead-in of an area is context, not a placeholder: only a section with nothing under it is one.
    assert "Planned for later." in next(n for n in nodes if n.title == "Requirements").description


def test_a_section_with_only_its_own_text_stays_as_context_in_its_parent(tmp_path: Path) -> None:
    """Owner answer (2026-11-26): a section with text but no requirement is not an item, and its text is document context kept in its
    parent's description: never dropped."""
    from app.loaders.text_loader import load_markdown

    reqs = "\n\n".join(f"REQ-{n:03d}: The unit shall perform function number {n} within {n} s." for n in range(1, 7))
    text = (
        f"# 1 Requirements\n\n## 1.1 Power\n\n{reqs}\n\n## 1.2 Operating concept\n\n"
        "The operator starts the unit from the front panel and watches its state on the status lamp.\n\n"
        "## 1.3 Data\n\nREQ-007: The unit shall log every event.\n"
    )
    path = tmp_path / "spec.md"
    path.write_text(text, encoding="utf-8")
    nodes = build_baseline_tree(load_markdown(str(path))).nodes
    assert not [n for n in nodes if n.title.startswith("Operating concept")]
    by_title = {n.title: n for n in nodes}
    assert "watches its state on the status lamp" in by_title["Requirements"].description
