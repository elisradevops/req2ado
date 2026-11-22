# ingestion/tests/test_worktree_schema_conformance.py
import json
from pathlib import Path

import jsonschema
import pytest

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import IntegrityWarning, KbCoverage, WarningKind

SCHEMA_PATH = Path(__file__).parents[2] / "shared" / "schemas" / "work-item-tree.schema.json"


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def _sr(path: str, start: int, end: int) -> SourceRef:
    return SourceRef(document_path=path, start_offset=start, end_offset=end)


def _baseline_doc() -> CanonicalDoc:
    path = "sample.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path, 0, 10)
            ),
            Block(
                id="b1",
                kind=BlockKind.PARAGRAPH,
                text="1.1 The receiver shall scan all available channels.",
                source_ref=_sr(path, 11, 63),
            ),
        ],
    )


def _survey_doc() -> CanonicalDoc:
    path = "survey_input.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path, 0, 10)),
            Block(
                id="b1",
                kind=BlockKind.PARAGRAPH,
                text="The display shall support HDR.",
                source_ref=_sr(path, 0, 10),
            ),
        ],
    )


class FakeSurveyModelClient:
    """Test double for SurveyModelClient: the job's chat-model client, which never decides the structure (it comes from the
    document). It has none of the optional passes (no file-conventions pre-study, no sheet study), so the document's own structure is
    used as-is."""

    model = None


def test_baseline_tree_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_survey_tree_matches_work_item_tree_schema(schema) -> None:
    tree = build_survey_tree(_survey_doc(), FakeSurveyModelClient())
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_survey_tree_with_a_real_warning_matches_work_item_tree_schema(schema) -> None:
    # Neither fixture above ever produces a non-empty `warnings` list, so
    # this schema's own IntegrityWarning shape (kind/severity/node_ids/
    # detail/raw) was never actually exercised against real serialized
    # output -- an empty array trivially satisfies any `items` schema
    # regardless of whether that schema is even correct.
    # A reference to a document the job did not ingest gives a warning with node ids and detail, the full warning shape.
    doc = _survey_doc()
    doc = doc.model_copy(
        update={"blocks": [block.model_copy(update={"text": f"{block.text} See ReqID 12345."}) for block in doc.blocks]}
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
    assert len(tree.warnings) >= 1
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_tree_with_kb_coverage_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.kb_coverage = KbCoverage(files_available=3, files_cited=1)
    dumped = tree.model_dump(mode="json")
    assert dumped["kb_coverage"] == {"files_available": 3, "files_cited": 1}
    jsonschema.validate(instance=dumped, schema=schema)


def test_baseline_tree_has_no_kb_coverage(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    assert tree.kb_coverage is None
    dumped = tree.model_dump(mode="json")
    assert dumped["kb_coverage"] is None
    jsonschema.validate(instance=dumped, schema=schema)


def test_unsupported_content_note_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.UNSUPPORTED_CONTENT_NOTE,
            "Unsupported content note found in document.",
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_empty_table_content_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.EMPTY_TABLE_CONTENT,
            "Empty table content encountered.",
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_vision_captioning_disabled_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.VISION_CAPTIONING_DISABLED,
            "Vision captioning was disabled for this run -- 2 figure(s) have no description as a result.",
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_insignificant_figure_ids_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.nodes[0].uncaptioned_figure_ids = ["f0", "f1"]
    tree.nodes[0].insignificant_figure_ids = ["f0"]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_invalid_mapping_target_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.INVALID_MAPPING_TARGET,
            "Figure f0 was mapped to a work item that isn't in this document -- the mapping was dropped.",
            detail={"itemId": "f0", "itemKind": "figure", "requested": "nope"},
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_mapping_call_failed_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.MAPPING_CALL_FAILED,
            "Figure/table mapping failed for this section -- 2 figure(s)/1 table(s) are listed as excluded instead.",
            detail={"tier": 1, "branch": "br0_", "figureCount": 2, "tableCount": 1},
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_ocr_recovered_table_text_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.OCR_RECOVERED_TABLE_TEXT,
            "Table t0 had 3 cell(s) recovered via OCR -- please spot-check against the source document.",
            detail={"tableId": "t0", "recoveredCellCount": 3},
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_missing_source_reference_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.MISSING_SOURCE_REFERENCE,
            "1 Requirement(s) have no document-authored Customer ID / source-requirement-number -- "
            "none was invented; review and add one manually if the source document has one that "
            "couldn't be automatically extracted.",
            node_ids=["n0"],
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_duplicate_customer_id_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.DUPLICATE_CUSTOMER_ID,
            "Customer ID 'PC104' was reported on 2 different Requirements -- a real customer ID is "
            "unique to one requirement, so it was removed from all of them rather than guessing which "
            "(if any) is correct; review and add the real ID manually if the source document has one.",
            node_ids=["n0", "n1"],
            detail={"duplicateValue": "PC104"},
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_survey_title_distilled_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.SURVEY_TITLE_DISTILLED,
            "1 node title(s) in this section were too generic/short to be useful and were replaced "
            "with a title distilled from the node's own generated description.",
            node_ids=["n0"],
            detail={"branch": "br0_", "totalDistilled": 1},
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_parent_title_collision_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.PARENT_TITLE_COLLISION,
            '"X" was proposed as the title of a parent item but matches the title of one of the '
            'requirements under it -- kept the original heading "Y" instead.',
            node_ids=["n0"],
            detail={
                "pass": "parent_summary",
                "rejectedTitle": "X",
                "fallbackTitle": "Y",
                "headingAlsoCollides": False,
            },
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_criteria_value_ungrounded_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.CRITERIA_VALUE_UNGROUNDED,
            "2 item(s) had acceptance criteria left out because they stated values the document "
            "does not contain (3 criterion(s) dropped).",
            node_ids=["n0", "n1"],
            detail={"pass": "acceptance_criteria", "dropped": 3, "assumptionOnly": 0},
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_missing_requirement_row_coverage_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.MISSING_REQUIREMENT_ROW_COVERAGE,
            "1 source table row(s) carry their own literal requirement identifier but no generated "
            "work item claims it -- those rows may have been merged into another requirement or "
            "dropped entirely: P-SENSOR-003# (Sync interval)",
            detail={
                "branch": "br0_",
                "unclaimedCodes": ["P-SENSOR-003#"],
                "totalIdentifiedRows": 3,
            },
        )
    ]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_excluded_figure_and_table_ids_match_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.excluded_figure_ids = ["f0", "f1"]
    tree.excluded_table_ids = ["t0"]
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_excluded_ids_default_to_empty_lists_on_every_tree(schema) -> None:
    # Both fields are doc-wide and additive -- BASELINE has no mapping stage
    # at all, and a SURVEY run whose client can't map still returns [].
    assert build_baseline_tree(_baseline_doc()).excluded_figure_ids == []
    assert build_baseline_tree(_baseline_doc()).excluded_table_ids == []
    survey_tree = build_survey_tree(_survey_doc(), FakeSurveyModelClient())
    assert survey_tree.excluded_figure_ids == []
    assert survey_tree.excluded_table_ids == []


def test_schema_rejects_a_stray_field_on_a_node(schema) -> None:
    # Regression: before additionalProperties:false, this schema was nearly
    # vacuous -- it validated any node shape, stray fields included, so a
    # silent shape drift between the Python and TypeScript sides of this
    # contract would never be caught here. This is the actual point of S4:
    # prove the schema now REJECTS something it used to silently accept.
    instance = build_baseline_tree(_baseline_doc()).model_dump(mode="json")
    instance["nodes"][0]["unexpected_field"] = "should not validate"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=instance, schema=schema)


def test_schema_rejects_a_stray_top_level_field(schema) -> None:
    instance = build_baseline_tree(_baseline_doc()).model_dump(mode="json")
    instance["unexpected_top_level_field"] = "should not validate"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=instance, schema=schema)


def test_v2_identity_and_content_hash_match_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    assert all(node.identity_hash_v2 for node in tree.nodes)
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)
    survey = build_survey_tree(_survey_doc(), FakeSurveyModelClient())
    # A SURVEY node that shares its source block with another real node has no identity of its own (null); every other one has one.
    keys = [(n.source_ref.start_offset, n.source_ref.end_offset, n.source_ref.page) for n in survey.nodes if "synth_" not in n.local_id]
    for node in survey.nodes:
        key = (node.source_ref.start_offset, node.source_ref.end_offset, node.source_ref.page)
        shares = "synth_" not in node.local_id and keys.count(key) > 1
        assert (node.identity_hash_v2 is None) == shares, node.local_id
    jsonschema.validate(instance=survey.model_dump(mode="json"), schema=schema)


def test_changed_since_written_warning_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    tree.warnings = [
        IntegrityWarning.make(
            WarningKind.CHANGED_SINCE_WRITTEN,
            "1 item matches one already in Azure DevOps whose text differs.",
            node_ids=["n1"],
            detail={"count": 1},
        )
    ]
    assert tree.warnings[0].severity == "needs_review"
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)
