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
        topic_count: int | None = None,
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
