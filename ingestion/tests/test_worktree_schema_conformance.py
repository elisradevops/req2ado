# ingestion/tests/test_worktree_schema_conformance.py
import json
from pathlib import Path

import jsonschema
import pytest

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import build_survey_tree
from app.leveling.tree_builder import build_baseline_tree

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
    one-call holistic analyze_section redesign) also conforms to the shared
    work-item-tree schema."""

    def analyze_section(
        self, section_text: str, kb_context: str | None = None, whole_document: bool = False,
        topic_count: int | None = None, table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
    ) -> tuple[list[dict], bool]:
        return [
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Display", "text": "The system shall handle: Display", "tags": []},
            {
                "temp_id": "n1",
                "type": "Requirement",
                "parent_temp_id": "n0",
                "title": "HDR support",
                "text": "The system shall handle: The display shall support HDR.",
                "tags": [],
            },
        ], False

    def analyze_section_agentic(self, section_text: str, retrieve_fn, **kwargs) -> tuple[list[dict], list[dict], bool]:
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
    # No "title" key at all -- triggers the NO_MODEL_TITLE warning
    # regardless of hierarchy shape (a lone root Requirement with no
    # Feature/Epic anywhere is otherwise a legitimate no-op, see
    # test_build_survey_tree_does_not_touch_a_genuinely_sole_root_requirement
    # in test_llm_leveling.py).
    fake.analyze_section = lambda *a, **k: (
        [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Shall do X.", "tags": []}],
        False,
    )
    tree = build_survey_tree(_survey_doc(), fake)
    assert len(tree.warnings) >= 1
    jsonschema.validate(instance=tree.model_dump(mode="json"), schema=schema)


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
