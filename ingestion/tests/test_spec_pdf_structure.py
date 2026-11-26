"""A customer specification PDF is read by its own structure, in both modes: front matter (cover, confidentiality notice, revision
history, contents, abbreviations, running header and footer) never becomes an item, every requirement is exactly one item, and every
section heading is an item.

The PDFs are synthetic look-alikes (fixtures/build_spec_pdf_fixture.py), one shape per variant, so a failure names the shape. SURVEY
runs with the structure-contract fakes: the model that writes wording is never asked for structure, so its items are fixed by code."""

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
from build_spec_pdf_fixture import VARIANTS, build_spec_pdf  # noqa: E402

from tests.test_structure_contract import (  # noqa: E402
    SimulatedGrouper,
    StructureRefusingClient,
    TitleHashEmbedder,
)

MODES = ("BASELINE", "SURVEY")


def _norm(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


@cache
def _built(variant: str, tmp_root: str):
    path, truth = build_spec_pdf(Path(tmp_root), variant)
    doc = load_pdf(str(path))
    trees = {
        "BASELINE": build_baseline_tree(doc),
        "SURVEY": build_survey_tree(
            doc,
            StructureRefusingClient(),
            grouping_client=SimulatedGrouper(1),
            embed_client=TitleHashEmbedder(),
        ),
    }
    return truth, trees


@pytest.fixture(scope="module")
def tmp_root(tmp_path_factory) -> str:
    return str(tmp_path_factory.mktemp("spec_pdfs"))


def _item_texts(tree) -> list[tuple[object, str]]:
    """Each item as the document states it: its title, then its Customer ID and its text ("REQ-001: The PDU shall ..."). The description
    no longer carries the code (it is the Customer ID: owner decision, 2026-11-25)."""
    return [
        (n, _norm(n.title) + " || " + _norm(f"{n.customer_id}: {n.description}" if n.customer_id else n.description))
        for n in tree.nodes
    ]


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("variant", list(VARIANTS))
def test_front_matter_never_becomes_an_item(variant: str, mode: str, tmp_root: str) -> None:
    truth, trees = _built(variant, tmp_root)
    texts = _item_texts(trees[mode])
    leaked = {
        fm[:50]: [f"{n.type.value}: {n.title[:40]}" for n, t in texts if _norm(fm)[:40] in t]
        for fm in truth.front_matter
    }
    leaked = {k: v for k, v in leaked.items() if v}
    assert not leaked, f"{variant}/{mode}: front matter inside items: {leaked}"


# Known limit: with no requirement code and no space between paragraphs, a one-line requirement that runs to the right margin cannot
# be told from a wrapped line, so it joins the next one. Splitting every paragraph at a sentence end would break ordinary prose.
_TIGHT_NO_ID = pytest.param(
    "tight_requirements_no_id",
    marks=pytest.mark.xfail(
        strict=True, reason="one-line requirement filling the line, set tight, with no code"
    ),
)


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize(
    "variant", [_TIGHT_NO_ID if v == "tight_requirements_no_id" else v for v in VARIANTS]
)
def test_every_requirement_is_exactly_one_item(variant: str, mode: str, tmp_root: str) -> None:
    truth, trees = _built(variant, tmp_root)
    texts = _item_texts(trees[mode])
    problems = []
    for req in truth.requirements:
        key = _norm(req)[:60]
        holders = [n for n, t in texts if key in t]
        if len(holders) != 1:
            problems.append(f"{req[:30]!r} is in {len(holders)} items")
            continue
        others = [
            r
            for r in truth.requirements
            if r != req and _norm(r)[:60] in _norm(holders[0].description)
        ]
        if others:
            problems.append(f"{req[:30]!r} shares its item with {len(others)} other requirement(s)")
    assert not problems, f"{variant}/{mode}: " + "; ".join(problems)


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("variant", list(VARIANTS))
def test_every_section_heading_is_an_item(variant: str, mode: str, tmp_root: str) -> None:
    truth, trees = _built(variant, tmp_root)
    from app.leveling.informational import is_informational

    titles = [_norm(n.title) for n in trees[mode].nodes]
    # A descriptive leaf (Scope) is kept in its parent's description, not as an item (test_a_scope_section_is_never_made_...).
    missing = [
        s
        for s in truth.section_titles
        if not any(t.endswith(_norm(s.split(" ", 1)[1])) for t in titles)
        and not is_informational(s, "")
    ]
    assert not missing, f"{variant}/{mode}: sections with no item: {missing}"


@pytest.mark.parametrize("variant", list(VARIANTS))
def test_survey_items_are_the_baseline_items(variant: str, tmp_root: str) -> None:
    _truth, trees = _built(variant, tmp_root)

    def key(tree) -> list[str]:
        return sorted(
            _norm(n.description)
            for n in tree.nodes
            if "synth_" not in n.local_id and n.description.strip()
        )

    baseline, survey = key(trees["BASELINE"]), key(trees["SURVEY"])
    assert set(survey) >= set(baseline), (
        f"{variant}: SURVEY lacks BASELINE items: {sorted(set(baseline) - set(survey))[:5]}"
    )


@pytest.mark.parametrize("mode", MODES)
def test_the_cover_title_names_the_epic(mode: str, tmp_root: str) -> None:
    from build_spec_pdf_fixture import DOC_TITLE

    _truth, trees = _built("all_together", tmp_root)
    # The chapters are areas made of sections (Epics under an Epic); the document's context describes the whole document, so the root
    # is the document's own Epic, named by its cover title (owner decision, 2026-11-25: Epic (system) -> Epic (area) -> Feature).
    roots = [n for n in trees[mode].nodes if n.parent_local_id is None]
    assert [(r.type.value, r.title) for r in roots] == [("Epic", DOC_TITLE)]
    areas = [n.title for n in trees[mode].nodes if n.type.value == "Epic" and n.parent_local_id == roots[0].local_id]
    assert areas == ["Power Requirements", "Built-In Test"]


@pytest.mark.parametrize("mode", MODES)
def test_what_was_left_out_is_reported_once_with_its_pages(mode: str, tmp_root: str) -> None:
    _truth, trees = _built("all_together", tmp_root)
    reports = [w for w in trees[mode].warnings if w.kind.value == "front_matter_left_out"]
    assert len(reports) == 1
    parts = [p["text"] for p in reports[0].detail["parts"]]
    assert {"Revision History", "Table of Contents", "Abbreviations"} <= set(parts)
    assert reports[0].detail["pages"]


def test_a_document_without_numbered_sections_keeps_its_opening_text(tmp_root: str) -> None:
    """Position alone leaves nothing out when the document does not number its sections."""
    from app.canonical.model import (
        Block,
        BlockKind,
        CanonicalDoc,
        Document,
        DocumentFormat,
        SourceRef,
    )
    from app.leveling.document_layout import find_front_matter

    def block(i: int, kind: BlockKind, text: str, level: int | None = None) -> Block:
        return Block(
            id=f"b{i}",
            kind=kind,
            text=text,
            heading_level=level,
            source_ref=SourceRef(document_path="x.md", start_offset=i, end_offset=i + 1),
        )

    doc = CanonicalDoc(
        document=Document(path="x.md", format=DocumentFormat.MD, sha256="0" * 64),
        blocks=[
            block(0, BlockKind.PARAGRAPH, "The unit shall start in under two seconds."),
            block(1, BlockKind.HEADING, "Power", 1),
            block(2, BlockKind.PARAGRAPH, "The unit shall draw at most 5 W."),
        ],
    )
    assert not find_front_matter(doc)


# --- review findings (2026-11-24): what must never be left out or split -------------------------------------------------------


def _md(*rows):
    from app.canonical.model import (
        Block,
        BlockKind,
        CanonicalDoc,
        Document,
        DocumentFormat,
        SourceRef,
    )

    kinds = {"h": BlockKind.HEADING, "p": BlockKind.PARAGRAPH}
    return CanonicalDoc(
        document=Document(path="x.md", format=DocumentFormat.MD, sha256="0" * 64),
        blocks=[
            Block(
                id=f"b{i}",
                kind=kinds[kind],
                text=text,
                heading_level=level,
                source_ref=SourceRef(document_path="x.md", start_offset=i, end_offset=i + 1),
            )
            for i, (kind, text, level) in enumerate(rows)
        ],
    )


_NUMBERED_BODY = [
    ("h", "1 Power", 1),
    ("p", "The unit shall draw at most 5 W.", None),
    ("h", "1.1 Input", 2),
    ("p", "The unit shall accept 28 V.", None),
    ("h", "2 Test", 1),
    ("p", "The unit shall run a self test.", None),
]


def test_an_unnumbered_intro_that_states_a_requirement_is_kept() -> None:
    from app.leveling.document_layout import find_front_matter

    doc = _md(
        ("h", "System requirements", 1),
        ("p", "The system shall boot in under 2 seconds.", None),
        *_NUMBERED_BODY,
    )
    assert not find_front_matter(doc)
    tree = build_baseline_tree(doc)
    assert any(
        "boot in under 2 seconds" in n.description or "boot in under 2 seconds" in n.title
        for n in tree.nodes
    )


def test_an_intro_titled_as_content_is_kept() -> None:
    from app.leveling.document_layout import find_front_matter

    doc = _md(
        ("h", "Overview", 1), ("p", "This document describes the unit.", None), *_NUMBERED_BODY
    )
    assert not find_front_matter(doc)


def test_a_cover_that_opens_with_a_document_number_is_still_front_matter() -> None:
    from app.leveling.document_layout import find_front_matter

    doc = _md(
        ("p", "DOC-1234 Rev A", None),
        (
            "p",
            "This document contains proprietary information. It shall not be reproduced without permission.",
            None,
        ),
        *_NUMBERED_BODY,
    )
    assert find_front_matter(doc).block_ids == {"b0", "b1"}


def test_headings_that_merely_start_with_a_number_are_not_section_numbers() -> None:
    from app.leveling.document_layout import find_front_matter

    doc = _md(
        ("h", "Power", 1),
        ("p", "Notes on the supply.", None),
        ("h", "5 V DC input", 2),
        ("h", "3 phase supply", 2),
        ("h", "12 V rail", 2),
    )
    assert not find_front_matter(doc)


def test_a_text_document_heading_is_not_promoted_to_title_unless_it_opens_the_document() -> None:
    from app.leveling.document_layout import find_front_matter

    doc = _md(
        ("p", "Prepared for the program office.", None),
        ("h", "Document History", 1),
        ("p", "Initial issue.", None),
        *_NUMBERED_BODY,
    )
    assert find_front_matter(doc).title_block_id is None


def test_a_wrapped_line_that_opens_with_a_standard_or_an_interface_does_not_split_a_paragraph() -> (
    None
):
    from app.loaders.pdf_loader import _lines_to_paragraphs

    def line(text: str, top: float, x1: float = 520.0) -> dict:
        return {
            "text": text,
            "top": top,
            "bottom": top + 10,
            "x0": 72.0,
            "x1": x1,
            "chars": [{"size": 10.0, "text": "x", "fontname": "Helvetica"}],
        }

    lines = [
        line("The unit shall comply with the environmental limits stated in", 100),
        line("ISO-9001 and MIL-STD-810 for the full operating range of the vehicle", 111),
        line("RS485 and CAN buses shall be isolated from chassis ground.", 122, 400),
    ]
    assert len(_lines_to_paragraphs(lines)) == 1


# --- owner example (2026-11-24): a descriptive section is not a requirement ------------------------------------------------------


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("variant", list(VARIANTS))
def test_a_scope_section_is_never_made_a_requirement_and_its_text_is_kept(
    variant: str, mode: str, tmp_root: str
) -> None:
    """ "1.1 Scope -- This specification defines the requirements of ..." became a Requirement, and SURVEY rewrote it as "The system
    shall define the requirements of ...": an obligation the document never states."""
    _truth, trees = _built(variant, tmp_root)
    nodes = trees[mode].nodes
    assert not [
        n for n in nodes if n.type.value == "Requirement" and _norm(n.title).endswith("scope")
    ]
    # The introduction describes the document: its text is kept, never as a Requirement -- in the root Epic's description where the
    # document's grammar builds the tree (owner decision, 2026-11-25), in an "Introduction" item where it does not (no requirement codes).
    holders = [n for n in nodes if "this specification defines the requirements" in _norm(n.description)]
    assert holders and all(n.type.value != "Requirement" for n in holders)
    assert [w for w in trees[mode].warnings if w.kind.value == "informational_section_folded"]


def test_a_context_titled_section_that_states_a_requirement_stays_a_requirement() -> None:
    from app.leveling.informational import is_informational

    assert not is_informational("1.2 General", "The unit shall be powered from the vehicle bus.")
    assert not is_informational("Scope", "REQ-010: The unit shall log every fault.")
    assert is_informational("1.1 Scope", "This specification defines the requirements of the unit.")
    assert is_informational("1.1 היקף", "מסמך זה מגדיר את הדרישות.")
    # A section whose title is not a context title is never judged by its wording (a requirement may have no "shall").
    assert not is_informational("2.1 Input Power", "The unit accepts 18 to 32 VDC.")


@pytest.mark.parametrize("mode", MODES)
def test_every_coded_requirement_carries_its_customer_id_and_its_title_does_not_repeat_it(
    mode: str, tmp_root: str
) -> None:
    _truth, trees = _built("all_together", tmp_root)
    requirements = [n for n in trees[mode].nodes if n.type.value == "Requirement"]
    assert sorted(n.customer_id for n in requirements) == [f"REQ-00{i}" for i in range(1, 8)]
    assert not [n.title for n in requirements if n.title.startswith("REQ-")]
    # The description keeps the document's words without the code, which is the Customer ID (owner decision, 2026-11-25).
    assert not [n.customer_id for n in requirements if n.customer_id in n.description]
    assert all(n.description.startswith("The PDU shall") for n in requirements)


def test_the_counts_tool_reports_numbers_only_never_the_documents_text(tmp_root: str) -> None:
    """The owner checks the real (sensitive) PDFs locally with scripts/pdf_structure_counts.py and shares its output."""
    import importlib.util
    import json

    spec = importlib.util.spec_from_file_location(
        "pdf_structure_counts", Path(__file__).parent.parent / "scripts" / "pdf_structure_counts.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    path, truth = build_spec_pdf(Path(tmp_root), "all_together")
    counts = module.counts_for(path)
    assert counts["items"] == {"Epic": 3, "Feature": 3, "Requirement": 7}
    assert counts["requirements_with_id"] == 7 and counts["requirements_with_several_ids"] == 0
    assert counts["contents_like_items"] == 0 and counts["numbered_sections_lost"] == 0
    dumped = json.dumps(counts).casefold()
    for text in [*truth.requirements, *truth.front_matter, *truth.section_titles]:
        assert _norm(text)[:20] not in dumped


def test_the_ingestion_image_ships_the_counts_tool() -> None:
    """A production probe runs it inside the container; the operator cannot download it from the repository."""
    dockerfile = (Path(__file__).parent.parent / "Dockerfile").read_text()
    assert "COPY scripts/pdf_structure_counts.py ./scripts/pdf_structure_counts.py" in dockerfile
