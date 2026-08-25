# ingestion/tests/test_worktree_schema_conformance.py
import json
from pathlib import Path

import jsonschema
import pytest

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree
from app.workitem.model import IntegrityWarning, WarningKind

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
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=_sr(path, 0, 10)),
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
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path, 0, 10)),
        ],
    )


class FakeSectionAnalysisClient:
    """Hand-written test double for SectionAnalysisClient — mirrors the fake
    used in tests/test_llm_leveling.py to prove SURVEY-mode output (via the
    two-stage skeleton + content-authoring generation split) also conforms to
    the shared work-item-tree schema."""

    _CONTENT = {
        "n0": {"description": "The system shall handle: Display", "tags": []},
        "n1": {"description": "The system shall handle: The display shall support HDR.", "tags": []},
    }

    def analyze_section_skeleton(
        self, section_text: str, kb_context: str | None = None, whole_document: bool = False,
        topic_count: int | None = None, table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
    ) -> tuple[list[dict], bool]:
        return [
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Display"},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "title": "HDR support"},
        ], False

    def author_content(
        self, section_text: str, skeleton_nodes: dict[str, dict], kb_context: str | None = None,
    ) -> tuple[dict[str, dict], bool]:
        return {
            local_id: self._CONTENT[local_id]
            for local_id in skeleton_nodes
            if local_id in self._CONTENT
        }, False

    def analyze_section_skeleton_agentic(self, section_text: str, retrieve_fn, **kwargs) -> tuple[list[dict], list[dict], bool]:
        raise AssertionError("not exercised by this test -- default model is not tool-capable")


def test_baseline_tree_matches_work_item_tree_schema(schema) -> None:
    tree = build_baseline_tree(_baseline_doc())
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_survey_tree_matches_work_item_tree_schema(schema) -> None:
    tree = build_survey_tree(_survey_doc(), FakeSectionAnalysisClient())
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


def test_survey_tree_with_a_real_warning_matches_work_item_tree_schema(schema) -> None:
    # Neither fixture above ever produces a non-empty `warnings` list, so
    # this schema's own IntegrityWarning shape (kind/severity/node_ids/
    # detail/raw) was never actually exercised against real serialized
    # output -- an empty array trivially satisfies any `items` schema
    # regardless of whether that schema is even correct.
    fake = FakeSectionAnalysisClient()
    # An empty "title" -- triggers the NO_MODEL_TITLE warning regardless of
    # hierarchy shape (a lone root Requirement with no Feature/Epic anywhere
    # is otherwise a legitimate no-op, see
    # test_build_survey_tree_does_not_touch_a_genuinely_sole_root_requirement
    # in test_llm_leveling.py).
    fake.analyze_section_skeleton = lambda *a, **k: (
        [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": ""}],
        False,
    )
    tree = build_survey_tree(_survey_doc(), fake)
    assert len(tree.warnings) >= 1
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


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
    survey_tree = build_survey_tree(_survey_doc(), FakeSectionAnalysisClient())
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
