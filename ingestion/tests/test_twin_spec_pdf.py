"""The twin of a real customer specification (fixtures/build_twin_spec_fixture.py) is read by its own structure, in both modes, with no
model: the document's own grammar (its requirement-code shape, what continues a requirement, its cover title, its context, empty and
back-matter sections) is learned from the document by code, and the tree it states comes out exactly.

SURVEY runs with the structure-contract fakes, so its items are fixed by code; the same file always gives the same tree."""

from __future__ import annotations

import re
import sys
from functools import cache
from pathlib import Path

import pytest

from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree
from app.loaders.pdf_loader import load_pdf

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from build_twin_spec_fixture import TRACE_LABEL, build_twin_spec_pdf  # noqa: E402

from tests.test_structure_contract import (  # noqa: E402
    SimulatedGrouper,
    StructureRefusingClient,
    TitleHashEmbedder,
)

MODES = ("BASELINE", "SURVEY")


def _norm(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def _survey(doc):
    return build_survey_tree(doc, StructureRefusingClient(), grouping_client=SimulatedGrouper(1), embed_client=TitleHashEmbedder())


@cache
def _built(tmp_root: str):
    path, truth = build_twin_spec_pdf(Path(tmp_root))
    doc = load_pdf(str(path))
    return truth, {"BASELINE": build_baseline_tree(doc), "SURVEY": _survey(doc)}, path


@pytest.fixture(scope="module")
def tmp_root(tmp_path_factory) -> str:
    return str(tmp_path_factory.mktemp("twin_pdf"))


def _requirements(tree):
    return [n for n in tree.nodes if n.type.value == "Requirement"]


def _holders(tree, text: str):
    key = _norm(text)[:70]
    return [n for n in _requirements(tree) if key in _norm(n.title + " " + n.description)]


def _number(node) -> str:
    """The section number of the heading an item was built from (its clean title no longer carries it)."""
    return _norm(node.source_title or node.title).split(" ", 1)[0]


def _section_of(tree, node) -> str | None:
    by_id = {n.local_id: n for n in tree.nodes}
    parent = by_id.get(node.parent_local_id or "")
    return _number(parent) if parent else None


@pytest.mark.parametrize("mode", MODES)
def test_one_root_epic_the_chapter_that_holds_the_requirements(mode: str, tmp_root: str) -> None:
    """The ladder (owner decision, 2026-11-25): the requirements chapter is the one root Epic, its areas made of sections are Epics under
    it, and only Epics are roots. Its generic name is the file's own until the user accepts a rename (next test)."""
    _truth, trees, _ = _built(tmp_root)
    roots = [n for n in trees[mode].nodes if n.parent_local_id is None]
    assert [(r.type.value, r.title, _number(r)) for r in roots] == [("Epic", "Requirements", "2")]


def test_an_accepted_rename_names_the_root_after_the_cover(tmp_root: str) -> None:
    from app.study.model_rules import document_headings
    from app.study.rulebook import DocumentRules, FileRulebook, Proposal

    truth, _trees, path = _built(tmp_root)
    doc = load_pdf(str(path))
    block_id = next(h["block_id"] for h in document_headings(doc) if h["number"] == "2")
    rename = Proposal(block_id, "rename", "Greenhouse Climate Controller (GCC)", "Named after the cover.")
    codes = ("gen_2", "enc_1", "mec_3")
    undecided = FileRulebook(document=DocumentRules(requirement_codes=codes, proposals=(rename,)))
    kept = FileRulebook(document=DocumentRules(requirement_codes=codes, proposals=(rename,), proposal_decisions=((block_id, "keep"),)))

    def root(rulebook) -> str:
        return next(n.title for n in build_baseline_tree(doc, rulebook).nodes if n.parent_local_id is None)

    # Proposals apply unless the user undoes them before Start (owner rule R4, 2026-11-26).
    assert truth.epic_title_contains.lower() in _norm(root(undecided))
    assert root(kept) == "Requirements"


@pytest.mark.parametrize("mode", MODES)
def test_every_requirement_is_exactly_one_requirement_under_its_section(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    tree = trees[mode]
    problems = []
    for section, req in truth.requirements:
        holders = _holders(tree, req.plain)
        if len(holders) != 1:
            problems.append(f"{req.code or req.plain[:30]} in {len(holders)} Requirements")
        elif _section_of(tree, holders[0]) != section:
            problems.append(f"{req.code} under {_section_of(tree, holders[0])}, not {section}")
    assert not problems, f"{mode}: {len(problems)} problems: " + "; ".join(problems[:12])
    assert len(_requirements(tree)) == len(truth.requirements)


@pytest.mark.parametrize("mode", MODES)
def test_the_requirement_code_is_the_customer_id_and_not_the_title(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    tree = trees[mode]
    problems = []
    for _, req in truth.requirements:
        for node in _holders(tree, req.plain):
            if node.customer_id != req.code:
                problems.append(f"{req.code or 'uncoded'}: Customer ID {node.customer_id!r}")
            if req.code and _norm(node.title).startswith(req.code):
                problems.append(f"{req.code}: title starts with the code")
    assert not problems, f"{mode}: {len(problems)} problems: " + "; ".join(problems[:12])
    assert sum(1 for n in _requirements(tree) if n.customer_id) == sum(1 for _, r in truth.requirements if r.code)


@pytest.mark.parametrize("mode", MODES)
def test_trace_lines_and_notes_stay_with_their_requirement(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    tree = trees[mode]
    problems = []
    for _, req in truth.requirements:
        holders = _holders(tree, req.plain)
        if len(holders) != 1:
            continue
        description = _norm(holders[0].description)
        missing = [p for p in req.parents if _norm(p) not in description]
        if req.parents and (_norm(TRACE_LABEL) not in description or missing):
            problems.append(f"{req.code}: trace not in its description ({missing[:2]})")
        for note in (req.note, req.full_note):
            if note and _norm(note) not in description:
                problems.append(f"{req.code}: Note not in its description")
    assert not problems, f"{mode}: {len(problems)} problems: " + "; ".join(problems[:12])


@pytest.mark.parametrize("mode", MODES)
def test_page_furniture_never_reaches_an_item(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    leaked = sorted(
        {f for f in truth.furniture for n in trees[mode].nodes if _norm(f)[:40] in _norm(n.title + " " + n.description)}
    )
    assert not leaked, f"{mode}: furniture inside items: {leaked}"


@pytest.mark.parametrize("mode", MODES)
def test_front_and_back_matter_never_become_items(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    texts = [_norm(n.title + " " + n.description) for n in trees[mode].nodes]
    leaked = [f for f in truth.front_matter if any(_norm(f)[:40] in t for t in texts)]
    leaked += [c for c in truth.back_matter_codes[:10] if any(c in t for t in texts)]
    assert not leaked, f"{mode}: front or back matter inside items: {leaked}"


@pytest.mark.parametrize("mode", MODES)
def test_context_and_empty_sections_are_never_requirements(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    tree = trees[mode]
    problems = []
    for s in truth.sections:
        if s.kind not in ("context", "empty"):
            continue
        for sentence in s.prose:
            if any(_norm(sentence)[:40] in _norm(n.title + " " + n.description) for n in _requirements(tree)):
                problems.append(f"{s.number} ({s.kind}) is inside a Requirement")
    assert not problems, f"{mode}: " + "; ".join(problems)


@pytest.mark.parametrize("mode", MODES)
def test_every_requirement_section_is_a_feature(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    nodes = trees[mode].nodes
    features = {_number(n) for n in nodes if n.type.value == "Feature"}
    items = {_number(n) for n in nodes}
    # A section that holds requirements is a Feature; a section made only of sections is an item too (an Epic, or a Feature under a
    # Feature): the ladder, owner decision 2026-11-25. An empty section is never an item (owner rule R2, 2026-11-26).
    missing = [s.number for s in truth.sections if s.reqs and s.number not in features]
    lost = [s.number for s in truth.sections if s.kind == "feature" and s.number not in items]
    empty_items = [s.number for s in truth.sections if s.kind == "empty" and s.number in items]
    assert not missing and not lost and not empty_items, (
        f"{mode}: sections with no Feature: {missing}; sections with no item: {lost}; empty sections made items: {empty_items}"
    )


@pytest.mark.parametrize("mode", MODES)
def test_tokens_inside_the_text_are_never_customer_ids(mode: str, tmp_root: str) -> None:
    truth, trees, _ = _built(tmp_root)
    wrong = sorted(
        {n.customer_id for n in trees[mode].nodes if n.customer_id and any(n.customer_id.startswith(t) for t in truth.not_customer_ids)}
    )
    assert not wrong, f"{mode}: tokens read as Customer IDs: {wrong}"


@pytest.mark.parametrize("mode", MODES)
def test_the_same_file_always_gives_the_same_tree(mode: str, tmp_root: str) -> None:
    _truth, trees, path = _built(tmp_root)

    def signature(tree) -> list[tuple]:
        return [(n.type.value, n.parent_local_id, n.title, n.customer_id, n.description) for n in tree.nodes]

    doc = load_pdf(str(path))
    again = build_baseline_tree(doc) if mode == "BASELINE" else _survey(doc)
    assert signature(again) == signature(trees[mode])


@pytest.mark.parametrize("mode", MODES)
def test_what_was_left_out_is_reported_once_with_the_sections_inside_the_body(mode: str, tmp_root: str) -> None:
    _truth, trees, _ = _built(tmp_root)
    reports = [w for w in trees[mode].warnings if w.kind.value == "front_matter_left_out"]
    assert len(reports) == 1
    parts = [p["text"] for p in reports[0].detail["parts"]]
    for section in ("1.3 REVISION HISTORY", "1.4 REFERENCES", "1.5 ABBREVIATIONS AND DEFINITIONS", "3 REQUIREMENT IDENTITIES"):
        assert section in parts, parts


def test_survey_items_are_the_baseline_items(tmp_root: str) -> None:
    _truth, trees, _ = _built(tmp_root)

    def key(tree) -> list[tuple]:
        return [(n.type.value, n.title, n.customer_id, _norm(n.description)) for n in tree.nodes]

    assert key(trees["SURVEY"]) == key(trees["BASELINE"])


@pytest.mark.parametrize("mode", MODES)
def test_a_left_out_part_reports_all_its_pages(mode: str, tmp_root: str) -> None:
    _truth, trees, _ = _built(tmp_root)
    report = next(w for w in trees[mode].warnings if w.kind.value == "front_matter_left_out")
    listing = next(p for p in report.detail["parts"] if p["text"] == "3 REQUIREMENT IDENTITIES")
    assert listing.get("pageEnd", listing["page"]) > listing["page"]  # the listing runs over several pages
    assert listing["pageEnd"] in report.detail["pages"]


@pytest.mark.parametrize("mode", MODES)
def test_the_trace_is_set_apart_from_the_requirement_text_by_a_blank_line(mode: str, tmp_root: str) -> None:
    _truth, trees, _ = _built(tmp_root)
    by_id = {n.customer_id: n for n in trees[mode].nodes if n.customer_id}
    statement, trace = by_id["mnt_13"].description.split("\n\n")
    # The code is the Customer ID, not part of the description (owner decision, 2026-11-25).
    assert statement.startswith("The housing material") and "Note: The agents are applied" in statement
    assert "mnt_13" not in by_id["mnt_13"].description
    assert trace.startswith(TRACE_LABEL) and "CLIMAT_118" in trace and "SYS_28.3" in trace
    assert "\n\n" in by_id["sup_6"].description  # a trace split by a page break is still one trace, after the blank line
    assert by_id["sup_6"].description.split("\n\n")[1].split() == ["Satisfies:", "GCS_9", "SYS_45"]
