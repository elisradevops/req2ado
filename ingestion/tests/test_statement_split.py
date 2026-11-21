"""Step 2 of the prompt root-cause work: the builders split a leaf heading whose body is several standalone statements,
the document Title names the Epic instead of being an item, and a table whose id rows make no item is not claimed."""

import json
from pathlib import Path

import jsonschema
import pytest

import app.leveling.tree_builder as tree_builder
from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.dispatch import dispatch_by_extension
from app.leveling.baseline_structure import adopt_baseline_structure
from app.leveling.id_hierarchy import is_standalone_statement, standalone_statement_flags
from app.leveling.llm_leveling import _detect_deterministic_subtrees
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import WarningKind, WorkItemMode, WorkItemNode, WorkItemType

FIXTURE = Path(__file__).parent / "prompt_evals" / "baselines" / "prompt-eval-fixture.docx"
SCHEMA_PATH = Path(__file__).parents[2] / "shared" / "schemas" / "canonical-doc.schema.json"


def _fixture_doc() -> CanonicalDoc:
    return dispatch_by_extension(FIXTURE.name, str(FIXTURE))


def _doc(*blocks: tuple[BlockKind, str, int | None]) -> CanonicalDoc:
    built: list[Block] = []
    offset = 0
    for index, (kind, text, level) in enumerate(blocks):
        built.append(
            Block(
                id=f"b{index}",
                kind=kind,
                text=text,
                heading_level=level,
                source_ref=SourceRef(
                    document_path="spec.docx", start_offset=offset, end_offset=offset + len(text)
                ),
            )
        )
        offset += len(text) + 1
    return CanonicalDoc(
        document=Document(path="spec.docx", format=DocumentFormat.DOCX, sha256="0" * 64),
        blocks=built,
        tables=[],
        figures=[],
    )


def _by_title(nodes, title: str):
    return next(n for n in nodes if n.title == title)


def _children(nodes, parent) -> list:
    return [n for n in nodes if n.parent_local_id == parent.local_id]


H, P, LI = BlockKind.HEADING, BlockKind.PARAGRAPH, BlockKind.LIST_ITEM


# --- the statement rule -------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("The system shall be user-friendly and fast.", True),
        ("היחידה תעבור למצב חיסכון בהספק לאחר 10 דקות ללא פעילות.", True),
        (
            "The unit is described in this section.",
            True,
        ),  # descriptive prose splits too (accepted; scoring flags it)
        ("The unit shall do this", False),  # no terminal punctuation
        ("Too short to stand.", False),
        ("The unit shall provide the following signals:", False),
        ("Input voltage: 28 VDC nominal, 32 VDC maximum.", False),  # a spec-cell label
    ],
)
def test_is_standalone_statement(text: str, expected: bool) -> None:
    assert is_standalone_statement(text) is expected


def test_items_after_a_lead_in_belong_to_it_until_the_next_labelled_paragraph() -> None:
    texts = [
        "The unit shall report its health to the host computer.",
        "**Engineering Notes:**",
        "Keep all station lists in configuration data, never hard-coded.",
        "All map rendering must work fully offline without exceptions.",
        "Acceptance Criteria: the health report arrives within one second.",
        "The unit shall log every fault with its UTC time stamp.",
    ]
    assert standalone_statement_flags(texts) == [True, False, False, False, False, True]


# --- the split in the builder -------------------------------------------------------------------------------------


def test_a_top_level_leaf_heading_with_two_statements_becomes_a_feature_with_two_requirements() -> (
    None
):
    doc = _doc(
        (H, "1 General", 1),
        (P, "The system shall be user-friendly and fast.", None),
        (P, "The unit shall operate from a supply voltage of TBD V.", None),
        (H, "2 Power", 1),
        (P, "The unit shall accept a 28 VDC input supply.", None),
    )
    nodes = build_baseline_tree(doc).nodes
    general = _by_title(nodes, "1 General")
    assert general.type == WorkItemType.FEATURE
    assert general.customer_id is None
    assert general.description == "1 General"
    children = _children(nodes, general)
    assert [c.local_id for c in children] == [f"{general.local_id}_s1", f"{general.local_id}_s2"]
    assert [c.description for c in children] == [
        "The system shall be user-friendly and fast.",
        "The unit shall operate from a supply voltage of TBD V.",
    ]
    assert all(c.type == WorkItemType.REQUIREMENT for c in children)
    assert children[0].source_ref.section_path == ["1 General"]
    assert children[0].source_ref.start_offset == doc.blocks[1].source_ref.start_offset
    # Document order: the children come right after their heading.
    index = nodes.index(general)
    assert nodes[index + 1 : index + 3] == children
    # A heading with one statement stays whole.
    assert _by_title(nodes, "2 Power").type == WorkItemType.REQUIREMENT
    assert not _children(nodes, _by_title(nodes, "2 Power"))


def test_a_leaf_under_a_requirement_stays_a_requirement_over_sub_requirements() -> None:
    doc = _doc(
        (H, "1.1 Power input", 2),
        (H, "1.1.1 Transients", 3),
        (P, "The unit shall tolerate transients up to 50 V.", None),
        (P, "The unit shall recover from a brown-out within 2 s.", None),
    )
    heading, leaf, first, second = doc.blocks

    def node(local_id, block, node_type, parent=None):
        return WorkItemNode(
            local_id=local_id,
            type=node_type,
            parent_local_id=parent,
            title=block.text,
            description=block.text,
            customer_id="1.1.1" if parent else None,
            source_ref=block.source_ref,
            fidelity_hash="",
            identity_hash="",
            tags=[],
            mode=WorkItemMode.BASELINE,
            child_type=WorkItemType.REQUIREMENT,
        )

    nodes = [
        node("n0", heading, WorkItemType.REQUIREMENT),
        node("n1", leaf, WorkItemType.REQUIREMENT, "n0"),
    ]
    folded = {"n1": [(first, first.text), (second, second.text)]}
    tree_builder._split_statement_bodies(
        nodes, {"n0": heading, "n1": leaf}, {"n0": heading.text, "n1": leaf.text}, folded, set(), {}
    )
    assert [(n.local_id, n.type, n.parent_local_id) for n in nodes] == [
        ("n0", WorkItemType.REQUIREMENT, None),
        ("n1", WorkItemType.REQUIREMENT, "n0"),
        ("n1_s1", WorkItemType.REQUIREMENT, "n1"),
        ("n1_s2", WorkItemType.REQUIREMENT, "n1"),
    ]
    assert nodes[1].customer_id == "1.1.1"  # still a Requirement, so it keeps its id


def test_a_type_the_file_states_is_not_split() -> None:
    doc = _doc(
        (H, "1 General", 1),
        (P, "The system shall be user-friendly and fast.", None),
        (P, "The unit shall operate from a supply voltage of TBD V.", None),
    )
    heading, first, second = doc.blocks
    nodes = [
        WorkItemNode(
            local_id="n0",
            type=WorkItemType.REQUIREMENT,
            parent_local_id=None,
            title=heading.text,
            description=heading.text,
            source_ref=heading.source_ref,
            fidelity_hash="",
            identity_hash="",
            tags=[],
            mode=WorkItemMode.BASELINE,
            child_type=WorkItemType.REQUIREMENT,
        )
    ]
    tree_builder._split_statement_bodies(
        nodes,
        {"n0": heading},
        {"n0": heading.text},
        {"n0": [(first, first.text), (second, second.text)]},
        set(),
        {"n0": WorkItemType.REQUIREMENT},
    )
    assert [n.local_id for n in nodes] == ["n0"]


def test_the_non_statement_parts_stay_on_the_split_heading() -> None:
    doc = _doc(
        (H, "1 Modes", 1),
        (P, "Modes:", None),
        (LI, "Standby uses less than 5 W.", None),
        (P, "Acceptance Criteria: measured on the bench.", None),
        (P, "The unit shall enter standby after 10 minutes idle.", None),
        (P, "The unit shall wake within 2 s of a command.", None),
    )
    nodes = build_baseline_tree(doc).nodes
    modes = _by_title(nodes, "1 Modes")
    assert modes.type == WorkItemType.FEATURE
    for kept in (
        "Modes:",
        "Standby uses less than 5 W.",
        "Acceptance Criteria: measured on the bench.",
    ):
        assert kept in modes.description
    assert "standby after 10 minutes" not in modes.description
    assert len(_children(nodes, modes)) == 2


@pytest.mark.parametrize(
    "body",
    [
        # One statement and its lead-in items: nothing stands alone twice.
        [
            (P, "The unit shall provide the following outputs:", None),
            (LI, "A 5 V rail rated for at least 2 A.", None),
            (LI, "A 12 V rail rated for at least 1 A.", None),
        ],
        # Short labels and fragments.
        [(P, "Status: open", None), (P, "TBD", None)],
    ],
)
def test_a_body_without_two_standalone_statements_stays_whole(body) -> None:
    nodes = build_baseline_tree(_doc((H, "1 Outputs", 1), *body, (H, "2 Other", 1))).nodes
    outputs = _by_title(nodes, "1 Outputs")
    assert not _children(nodes, outputs)
    assert outputs.type == WorkItemType.REQUIREMENT


def test_a_heading_that_is_itself_a_statement_stays_whole() -> None:
    doc = _doc(
        (H, "1 The unit shall accept a 28 VDC input supply.", 1),
        (P, "The supply comes from the vehicle bus through J1.", None),
        (P, "The bus is protected by a 10 A fuse on the vehicle side.", None),
        (H, "2 Other", 1),
    )
    nodes = build_baseline_tree(doc).nodes
    heading = next(n for n in nodes if n.title.startswith("1 The unit shall"))
    assert not _children(nodes, heading)


# --- the document Title -------------------------------------------------------------------------------------------


def test_the_title_is_not_an_item_and_names_the_document_epic() -> None:
    doc = _doc(
        (BlockKind.TITLE, "Eval Unit Specification", None),
        (H, "1 Power", 1),
        (P, "The unit shall accept a 28 VDC input supply.", None),
    )
    nodes = build_baseline_tree(doc).nodes
    assert all(
        "Eval Unit Specification" not in n.description or n.local_id.startswith("synth_")
        for n in nodes
    )
    epic = next(n for n in nodes if n.type == WorkItemType.EPIC)
    assert epic.title == "Eval Unit Specification"


def test_a_headingless_document_epic_is_named_by_its_title() -> None:
    doc = _doc(
        (BlockKind.TITLE, "Eval Unit Specification", None),
        (P, "The unit shall accept a 28 VDC input supply.", None),
        (P, "The unit shall weigh no more than 3 kg.", None),
    )
    nodes = build_baseline_tree(doc).nodes
    epic = next(n for n in nodes if n.type == WorkItemType.EPIC)
    assert epic.title == "Eval Unit Specification"
    assert sorted(n.description for n in nodes if n.type == WorkItemType.REQUIREMENT) == [
        "The unit shall accept a 28 VDC input supply.",
        "The unit shall weigh no more than 3 kg.",
    ]


def test_a_document_with_only_a_title_has_no_items() -> None:
    assert build_baseline_tree(_doc((BlockKind.TITLE, "Eval Unit Specification", None))).nodes == []


def test_the_schema_accepts_a_title_block() -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    doc = _doc((BlockKind.TITLE, "Eval Unit Specification", None), (H, "1 Power", 1)).model_dump(
        mode="json"
    )
    jsonschema.validate(instance=doc, schema=schema)
    doc["blocks"][0]["kind"] = "subtitle"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=doc, schema=schema)


# --- the eval fixture, both modes ---------------------------------------------------------------------------------


def _assert_fixture_shape(nodes) -> None:
    general = _by_title(nodes, "4 General")
    assert general.type == WorkItemType.FEATURE
    assert len(_children(nodes, general)) == 2
    hebrew = _by_title(nodes, "3 ניהול צריכת הספק")
    assert hebrew.type == WorkItemType.FEATURE
    assert len(_children(nodes, hebrew)) == 3
    assert all(
        n.title != "Eval Unit Specification" or n.type == WorkItemType.EPIC or "synth" in n.local_id
        for n in nodes
    )
    epic = next(n for n in nodes if n.type == WorkItemType.EPIC)
    assert epic.title == "Eval Unit Specification"
    connector = _by_title(nodes, "2 Connector J1")
    assert connector.table_ids == ["t1"]
    assert "+28V" in connector.description
    assert not _children(nodes, connector)


def test_the_fixture_in_baseline() -> None:
    tree = build_baseline_tree(_fixture_doc())
    _assert_fixture_shape(tree.nodes)
    assert not [w for w in tree.warnings if w.kind == WarningKind.DROPPED_ROW]


def test_the_fixture_in_survey_folds_the_pin_table_into_its_section() -> None:
    doc = _fixture_doc()
    det_nodes, det_warnings, residual = _detect_deterministic_subtrees(doc, None, None, None, "m")
    # The Pin | Signal rows carry ids 1..6 but none is an item: the table is left to the residual, not dropped.
    assert det_nodes == []
    assert not [w for w in det_warnings if w.kind == WarningKind.DROPPED_ROW]
    assert "t1" in [t.id for t in residual.tables]
    nodes, warnings = adopt_baseline_structure(residual)
    _assert_fixture_shape(nodes)
    assert not [w for w in warnings if w.kind == WarningKind.DROPPED_ROW]


def test_the_split_leaves_the_unsplit_items_identities_unchanged(monkeypatch) -> None:
    split = build_baseline_tree(_fixture_doc()).nodes
    monkeypatch.setattr(tree_builder, "_split_statement_bodies", lambda *args: None)
    whole = build_baseline_tree(_fixture_doc()).nodes

    split_headings = {"3 ניהול צריכת הספק", "4 General"}
    whole_by_identity = {n.identity_hash: n for n in whole}
    unsplit = [
        n
        for n in split
        if n.title not in split_headings and not n.local_id.rsplit("_", 1)[-1].startswith("s")
    ]
    assert len(unsplit) == len(whole) - len(split_headings)
    for node in unsplit:
        before = whole_by_identity[node.identity_hash]
        assert (node.identity_hash_v2, node.content_hash) == (
            before.identity_hash_v2,
            before.content_hash,
        ), node.title
    for title in split_headings:
        assert _by_title(split, title).content_hash != _by_title(whole, title).content_hash
