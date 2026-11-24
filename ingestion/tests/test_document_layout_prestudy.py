"""The pre-study also learns the document's front matter: the model names headings by number only, code checks each one against the
document, the answer is stored with the file (a front-matter-only answer is a real answer), and the structure step leaves those
sections out in both modes."""

from __future__ import annotations

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.tree_builder import build_baseline_tree
from app.study.model_rules import (
    check_rulebook,
    document_headings,
    prestudy,
    validate_document_answer,
    vote_documents,
)
from app.study.rulebook import (
    DocumentRules,
    FileRulebook,
    FrontMatterPart,
    rulebook_from_json,
    rulebook_to_json,
)
from app.workitem.model import WarningKind

H, P = BlockKind.HEADING, BlockKind.PARAGRAPH


def _doc(*rows: tuple[BlockKind, str, int | None]) -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="spec.md", format=DocumentFormat.MD, sha256="0" * 64),
        blocks=[
            Block(
                id=f"b{i}",
                kind=kind,
                text=text,
                heading_level=level,
                source_ref=SourceRef(document_path="spec.md", start_offset=i, end_offset=i + 1),
            )
            for i, (kind, text, level) in enumerate(rows)
        ],
    )


# Unnumbered sections: position alone leaves nothing out, so only the learned layout can.
DOC = _doc(
    (H, "Document History", 1),
    (P, "Version 1.0 released for review by the program office.", None),
    (P, "Version 1.1 corrected the power budget table.", None),
    (H, "Acronyms", 1),
    (P, "PDU Power Distribution Unit; BIT Built-In Test.", None),
    (H, "Power", 1),
    (P, "The unit shall accept 18 to 32 VDC.", None),
    (H, "Input", 2),
    (P, "The unit shall withstand an 80 V transient for 100 ms.", None),
    (H, "Output", 2),
    (P, "The unit shall provide a 12 V rail.", None),
    (H, "Test", 1),
    (P, "The unit shall run a power-up test.", None),
    (H, "Reporting", 2),
    (P, "The unit shall report each fault with a code.", None),
    (P, "The unit shall keep the last 100 faults.", None),
)


def _answer(front: list[dict]) -> dict:
    return {
        "type_source": "none",
        "labels": [],
        "depth_types": [],
        "evidence_headings": [],
        "front_matter_headings": front,
    }


def _i(text: str) -> int:
    return next(h["i"] for h in document_headings(DOC) if h["text"] == text)


def test_a_named_front_matter_heading_is_checked_and_kept() -> None:
    rules = validate_document_answer(
        _answer(
            [
                {"i": _i("Document History"), "role": "revision_history"},
                {"i": _i("Acronyms"), "role": "abbreviations"},
            ]
        ),
        document_headings(DOC),
        DOC,
    )
    assert isinstance(rules, DocumentRules)
    assert rules.front_matter == (
        FrontMatterPart("b0", "revision_history"),
        FrontMatterPart("b3", "abbreviations"),
    )


def test_a_section_with_a_requirement_code_is_never_front_matter() -> None:
    doc = _doc(
        *[(k, t, lv) for k, t, lv in [(b.kind, b.text, b.heading_level) for b in DOC.blocks]],
        (H, "Annex", 1),
        (P, "REQ-090: The unit shall log.", None),
    )
    headings = document_headings(doc)
    annex = next(h["i"] for h in headings if h["text"] == "Annex")
    assert isinstance(
        validate_document_answer(_answer([{"i": annex, "role": "other"}]), headings, doc), str
    )


def test_an_answer_that_would_leave_out_the_body_is_refused() -> None:
    every = [{"i": h["i"], "role": "other"} for h in document_headings(DOC)]
    assert isinstance(validate_document_answer(_answer(every), document_headings(DOC), DOC), str)


def test_unknown_headings_and_roles_are_dropped_not_fatal() -> None:
    rules = validate_document_answer(
        _answer(
            [
                {"i": 999, "role": "cover"},
                {"i": _i("Acronyms"), "role": "sales"},
                {"i": _i("Acronyms"), "role": "abbreviations"},
            ]
        ),
        document_headings(DOC),
        DOC,
    )
    assert isinstance(rules, DocumentRules) and [p.block_id for p in rules.front_matter] == ["b3"]


def test_a_majority_decides_each_part() -> None:
    a = DocumentRules(
        front_matter=(
            FrontMatterPart("b0", "revision_history"),
            FrontMatterPart("b3", "abbreviations"),
        )
    )
    b = DocumentRules(front_matter=(FrontMatterPart("b0", "other"),))
    c = DocumentRules(front_matter=(FrontMatterPart("b0", "revision_history"),))
    assert vote_documents([a, b, c]).front_matter == (FrontMatterPart("b0", "revision_history"),)


class _Scripted:
    """The document pre-study model, answering the same front matter on every vote."""

    def __init__(self, front: list[dict]) -> None:
        self.front = front
        self.samples: list[dict] = []

    def study_file_rules_document(self, sample, user_id=None, vote=0, accept=None):  # noqa: ANN001
        self.samples.append(sample)
        return _answer(self.front)

    def study_file_rules_table(self, *args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("a document is not a table")


def test_a_front_matter_only_reading_is_a_stored_rulebook_and_shapes_the_items() -> None:
    client = _Scripted(
        [
            {"i": _i("Document History"), "role": "revision_history"},
            {"i": _i("Acronyms"), "role": "abbreviations"},
        ]
    )
    rulebook, warnings = prestudy(DOC, client, votes=3)
    assert not rulebook.is_empty()
    assert [w.kind for w in warnings] == [WarningKind.PRESTUDY_APPLIED]

    without = build_baseline_tree(DOC)
    learned = build_baseline_tree(DOC, rulebook)
    assert any("Document History" in n.title for n in without.nodes)
    assert not any("Document History" in n.title or "Acronyms" in n.title for n in learned.nodes)
    assert not any(
        "Version 1.0" in n.description or "PDU Power" in n.description for n in learned.nodes
    )
    assert [w for w in learned.warnings if w.kind == WarningKind.FRONT_MATTER_LEFT_OUT]


def test_the_model_reads_the_outline_without_the_front_matter_code_already_found() -> None:
    doc = _doc(
        (H, "Table of Contents", 1),
        (P, "1 Power ........ 2", None),
        (P, "2 Test ........ 3", None),
        *[(b.kind, b.text, b.heading_level) for b in DOC.blocks[5:]],
        (H, "Storage", 1),
        (P, "The unit shall store its settings.", None),
    )
    client = _Scripted([])
    prestudy(doc, client, votes=1)
    shown = [h["text"] for h in client.samples[0]["headings"]]
    assert "Table of Contents" not in shown and not any("...." in t for t in shown)


def test_front_matter_round_trips_and_a_rulebook_without_it_keeps_its_hash() -> None:
    with_front = FileRulebook(
        document=DocumentRules(front_matter=(FrontMatterPart("b0", "revision_history"),))
    )
    assert rulebook_from_json(rulebook_to_json(with_front)) == with_front
    plain = FileRulebook(document=DocumentRules(depth_types=((0, "Feature"),)))
    assert "front_matter" not in plain.canonical()["document"]


def test_an_edit_that_leaves_out_a_missing_heading_or_requirements_is_refused() -> None:
    missing = FileRulebook(document=DocumentRules(front_matter=(FrontMatterPart("nope", "other"),)))
    assert check_rulebook(DOC, missing) is not None
    ok = FileRulebook(
        document=DocumentRules(front_matter=(FrontMatterPart("b0", "revision_history"),))
    )
    assert check_rulebook(DOC, ok) is None


class _Failing(_Scripted):
    def study_file_rules_document(self, sample, user_id=None, vote=0, accept=None):  # noqa: ANN001
        raise TimeoutError("the model did not answer")


def test_a_reading_the_model_could_not_be_reached_for_is_marked_transient_and_an_answered_empty_one_is_not() -> (
    None
):
    _rulebook, warnings = prestudy(DOC, _Failing([]), votes=3)
    assert [w.detail["transient"] for w in warnings if w.kind == WarningKind.PRESTUDY_REJECTED] == [
        True
    ]
    _rulebook, warnings = prestudy(DOC, _Scripted([]), votes=3)
    assert [w.detail["transient"] for w in warnings if w.kind == WarningKind.PRESTUDY_REJECTED] == [
        False
    ]
