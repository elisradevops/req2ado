"""The TV twin (fixtures/tv_twin) in every format gives one tree: tv_gold_tree.json, the hand study of the document applied.

Three groups:
- the gold tree itself keeps the owner's decisions (clean titles, descriptions without codes and with the trace set apart, Epic/Feature
  descriptions only from the file's own text, derived marks never mixed with the file's tags, the Epic -> Feature -> Requirement ladder);
- every rendering (PDF, DOCX, DOC) carries the whole document to the reader: every code and every requirement text;
- every format, in both modes, builds the gold tree: its structure by code alone, then its requirements' short titles through the title
  pass (app.leveling.requirement_titles), with a model that answers the hand study's titles and the pass's own checks applied.

The .doc is the .docx converted by LibreOffice and is committed; reading it needs `soffice`, so its cases skip where it is missing."""

from __future__ import annotations

import json
import re
import shutil
import sys
from functools import cache
from pathlib import Path

import pytest

from app.dispatch import dispatch_by_extension
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.requirement_titles import write_requirement_titles
from app.leveling.tree_builder import build_baseline_tree
from app.study.model_rules import cover_lines, document_headings, validate_document_answer
from app.study.rulebook import DocumentRules, FileRulebook

TV_TWIN = Path(__file__).parent / "fixtures" / "tv_twin"
sys.path.insert(0, str(TV_TWIN))
from build_tv_twin_docx import build_tv_twin_docx  # noqa: E402
from build_tv_twin_pdf import SECTIONS, TRACE_LABEL, build_twin_spec_pdf, twin_truth  # noqa: E402

from tests.test_structure_contract import (  # noqa: E402
    SimulatedGrouper,
    StructureRefusingClient,
    TitleHashEmbedder,
)

GOLD = json.loads((TV_TWIN / "tv_gold_tree.json").read_text(encoding="utf-8"))["nodes"]
GOLD_BY_ID = {n["id"]: n for n in GOLD}
FORMATS = ("pdf", "docx", "doc")
MODES = ("BASELINE", "SURVEY")
DERIVED_MARKS = {"TBD", "Should", "Will", "No obligation"}
CODE = re.compile(r"\b[a-z]{3}_\d+(?:\.[a-z])?\b")
NEEDS_SOFFICE = pytest.mark.skipif(
    shutil.which("soffice") is None, reason="soffice (LibreOffice) is not installed"
)


def _norm(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def _format_param(fmt: str):
    return pytest.param(fmt, marks=NEEDS_SOFFICE) if fmt == "doc" else fmt


@pytest.fixture(scope="module")
def tmp_root(tmp_path_factory) -> str:
    return str(tmp_path_factory.mktemp("tv_twin"))


@cache
def _source(fmt: str, tmp_root: str) -> Path:
    if fmt == "pdf":
        return build_twin_spec_pdf(Path(tmp_root))[0]
    if fmt == "docx":
        return build_tv_twin_docx(Path(tmp_root))[0]
    copy = Path(tmp_root) / "tv_twin_spec.doc"
    shutil.copy(TV_TWIN / "tv_twin_spec.doc", copy)
    return copy


@cache
def _doc(fmt: str, tmp_root: str):
    return dispatch_by_extension(f"tv_twin_spec.{fmt}", str(_source(fmt, tmp_root)))


def _study(doc) -> FileRulebook:
    """What the file study answers for the TV twin (the hand study), keyed by heading number and cover line, checked by the same code
    that checks a model's answer. Its proposals are undecided, so the target keeps the file's original names."""
    headings = document_headings(doc)
    by_number = {h["number"]: h["i"] for h in headings if h["number"]}
    cover = cover_lines(doc)
    answer = {
        "type_source": "none",
        "labels": [],
        "depth_types": [],
        "evidence_headings": [],
        "front_matter_headings": [],
        "requirement_codes": ["aud_1", "btn_2", "men_3", "tun_1"],
        "leaf_convention": "feature_and_requirement",
        "empty_sections": "leave_out",
        "context_headings": [by_number["1.1"], by_number["1.2"]],
        "back_matter_headings": [by_number["3"]],
        "document_kind": "requirements_export",
        "cover_title_lines": [line["j"] for line in cover if "Vireo Television" in line["text"] or line["text"].startswith("Set (VTS)")],
        "proposals": [
            {"i": by_number["2"], "action": "rename", "new_title": "Vireo Television Set (VTS)", "reason": "Named after the cover."},
            {"i": by_number["2.1"], "action": "drop_wrapper", "new_title": "", "reason": "A generic name holding one section."},
            {"i": by_number["2.4"], "action": "rename", "new_title": "Environment and safety", "reason": "Named from its two sections."},
        ],
        "spelling_fixes": [{"i": by_number["2.3.4"], "fixed": "Enclosure"}],
        "title_policy": "write",
    }
    rules = validate_document_answer(answer, headings, doc, cover=cover)
    assert isinstance(rules, DocumentRules), rules
    return FileRulebook(document=rules)


class _GoldTitles:
    """A model that writes the hand study's title for each requirement it is shown (matched by the requirement's text). The titles still
    go through the pass's own checks, so a gold title the checks refused would show up as a mismatch."""

    def __init__(self) -> None:
        self.by_text = {_norm(n["description"].split("\n\n", 1)[0]): n["title"] for n in GOLD if n["type"] == "Requirement"}

    def requirement_titles(self, texts_by_id: dict[str, str], user_id: str | None = None) -> dict[str, dict]:
        return {k: {"title": self.by_text[_norm(v)]} for k, v in texts_by_id.items() if _norm(v) in self.by_text}


@cache
def _tree(fmt: str, mode: str, tmp_root: str):
    doc = _doc(fmt, tmp_root)
    rulebook = _study(doc)
    if mode == "BASELINE":
        tree = build_baseline_tree(doc, rulebook)
    else:
        tree = build_survey_tree(
            doc,
            StructureRefusingClient(),
            grouping_client=SimulatedGrouper(1),
            embed_client=TitleHashEmbedder(),
            rulebook=rulebook,
        )
    write_requirement_titles(tree.nodes, _GoldTitles(), tree.warnings)  # what /level does after either build
    return tree


# --- the gold tree keeps the owner's decisions ---------------------------------------------------------------------------------------


def test_the_gold_tree_has_the_documents_counts() -> None:
    types = [n["type"] for n in GOLD]
    codes = [n["customer_id"] for n in GOLD if n["customer_id"]]
    assert (types.count("Epic"), types.count("Feature"), types.count("Requirement")) == (
        10,
        25,
        121,
    )
    assert len(codes) == len(set(codes)) == 120


def test_gold_titles_are_clean() -> None:
    bad = [
        n["title"]
        for n in GOLD
        if re.match(r"^\s*\d", n["title"])
        or CODE.search(n["title"])
        or re.search(r"\([A-Z0-9_]+\)$", n["title"])
    ]
    assert not bad, bad


def test_gold_requirement_descriptions_have_no_code_and_set_the_trace_apart() -> None:
    problems = []
    for n in (n for n in GOLD if n["type"] == "Requirement"):
        statement, _, trace = n["description"].partition("\n\n")
        if CODE.search(statement):
            problems.append(f"{n['customer_id']}: a code in the text")
        if TRACE_LABEL in statement or (trace and not trace.startswith(TRACE_LABEL)):
            problems.append(f"{n['customer_id']}: trace not set apart by a blank line")
    assert not problems, problems


def test_gold_epic_and_feature_descriptions_are_only_the_files_own_text() -> None:
    file_text = _norm(
        " ".join(
            [
                *(p for s in SECTIONS for p in s.prose),
                *(r.full_note or "" for s in SECTIONS for r in s.reqs),
            ]
        )
    )
    containers = [n for n in GOLD if n["type"] != "Requirement"]
    invented = [
        n["title"]
        for n in containers
        if n["description"] and _norm(n["description"]) not in file_text
    ]
    title_echo = [
        n["title"]
        for n in containers
        if n["description"] and _norm(n["description"]) == _norm(n["title"])
    ]
    assert not invented and not title_echo, (invented, title_echo)
    assert sum(1 for n in containers if n["description"]) == 1  # the top Epic: the context sections


def test_gold_derived_marks_are_review_marks_and_the_file_states_no_tags_or_types() -> None:
    assert {m for n in GOLD for m in n["derived_marks"]} <= DERIVED_MARKS
    assert all(n["file_tags"] == [] and n["requirement_type"] is None for n in GOLD)


def test_gold_follows_the_ladder() -> None:
    problems = []
    for n in GOLD:
        parent = GOLD_BY_ID.get(n["parent"]) if n["parent"] else None
        if parent is None and n["type"] != "Epic":
            problems.append(f"a {n['type']} root: {n['title']}")
        if parent and n["type"] == "Requirement" and parent["type"] == "Epic":
            problems.append(f"Requirement under an Epic: {n['title']}")
        if parent and n["type"] == "Epic" and parent["type"] != "Epic":
            problems.append(f"Epic under a {parent['type']}: {n['title']}")
        if parent and n["type"] == "Feature" and parent["type"] == "Requirement":
            problems.append(f"Feature under a Requirement: {n['title']}")
    assert not problems, problems


def test_gold_holds_every_requirement_the_document_states_once() -> None:
    truth = twin_truth()
    gold_reqs = [n for n in GOLD if n["type"] == "Requirement"]
    missing = [
        r.code or r.plain[:30]
        for _, r in truth.requirements
        if sum(1 for n in gold_reqs if _norm(r.plain) in _norm(n["description"])) != 1
    ]
    assert not missing, missing
    assert len(gold_reqs) == len(truth.requirements)


# --- every rendering carries the whole document --------------------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", [_format_param(f) for f in FORMATS])
def test_every_format_carries_every_code_and_requirement_text(fmt: str, tmp_root: str) -> None:
    doc = _doc(fmt, tmp_root)
    text = _norm(" ".join(b.text for b in doc.blocks))
    truth = twin_truth()
    missing_codes = [
        r.code
        for _, r in truth.requirements
        if r.code and not re.search(rf"\b{re.escape(r.code)}\b", text)
    ]
    missing_texts = [
        r.code or "uncoded" for _, r in truth.requirements if _norm(r.plain)[:60] not in text
    ]
    assert not missing_codes and not missing_texts, (missing_codes[:5], missing_texts[:5])


# --- every format builds the gold tree -----------------------------------------------------------------------------------------------


def _gold_projection(requirement_titles: bool = True) -> set[tuple]:
    def title(n: dict) -> str:
        return n["title"] if requirement_titles or n["type"] != "Requirement" else n["customer_id"] or "-"

    def path(n: dict) -> tuple[str, ...]:
        chain = []
        while n:
            chain.append(title(n))
            n = GOLD_BY_ID.get(n["parent"]) if n["parent"] else None
        return tuple(reversed(chain))

    return {(path(n), n["type"], n["customer_id"], _norm(n["description"]), tuple(n["derived_marks"])) for n in GOLD}


def _tree_projection(tree, requirement_titles: bool = True) -> set[tuple]:
    by_id = {n.local_id: n for n in tree.nodes}

    def title(n) -> str:
        return n.title if requirement_titles or n.type.value != "Requirement" else n.customer_id or "-"

    def path(n) -> tuple[str, ...]:
        chain = []
        while n:
            chain.append(title(n))
            n = by_id.get(n.parent_local_id or "")
        return tuple(reversed(chain))

    return {
        (path(n), n.type.value, n.customer_id, _norm(n.description), tuple(getattr(n, "derived_marks", None) or ()))
        for n in tree.nodes
    }


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("fmt", [_format_param(f) for f in FORMATS])
def test_every_format_builds_the_gold_structure(fmt: str, mode: str, tmp_root: str) -> None:
    """Everything but the requirements' own titles, which the title pass writes (wave 1, step 4): the ladder, every Epic and Feature
    title, every Customer ID, every description and every derived mark."""
    got, want = _tree_projection(_tree(fmt, mode, tmp_root), False), _gold_projection(False)
    missing, extra = sorted(want - got), sorted(got - want)
    assert not missing and not extra, (
        f"{fmt}/{mode}: {len(missing)} missing, {len(extra)} extra; first missing {missing[:3]}; first extra {extra[:3]}"
    )


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("fmt", [_format_param(f) for f in FORMATS])
def test_every_format_builds_the_gold_tree(fmt: str, mode: str, tmp_root: str) -> None:
    got, want = _tree_projection(_tree(fmt, mode, tmp_root)), _gold_projection()
    missing, extra = sorted(want - got), sorted(got - want)
    assert not missing and not extra, (
        f"{fmt}/{mode}: {len(missing)} missing, {len(extra)} extra; first missing {missing[:3]}; first extra {extra[:3]}"
    )
