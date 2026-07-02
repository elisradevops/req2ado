from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import LlmLevelingClient, build_survey_tree
from app.workitem.model import WorkItemMode, WorkItemType


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _small_doc() -> CanonicalDoc:
    path = "survey_input.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )


class FakeLlmLevelingClient:
    """Hand-written test double proving the LlmLevelingClient interface/wiring
    works end-to-end. No real Open WebUI call exists yet in this phase — the
    orchestrator's LLM proxy is separate, not-yet-built infrastructure."""

    def infer_hierarchy(self, outline: str, profile_hint: str | None) -> list[dict]:
        assert "Display" in outline
        assert "HDR" in outline
        return [
            {"node_id": "0", "type": "Feature", "parent_id": None},
            {"node_id": "1", "type": "Requirement", "parent_id": "0"},
        ]


def test_build_survey_tree_uses_injected_llm_client() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient())
    assert len(tree.nodes) == 2
    assert tree.nodes[0].type == WorkItemType.FEATURE
    assert tree.nodes[0].parent_local_id is None
    assert tree.nodes[1].type == WorkItemType.REQUIREMENT
    assert tree.nodes[1].parent_local_id == "0"


def test_survey_tree_nodes_have_survey_mode_and_no_fidelity_hash() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient())
    for node in tree.nodes:
        assert node.mode == WorkItemMode.SURVEY
        assert node.fidelity_hash is None


def test_llm_leveling_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: LlmLevelingClient = FakeLlmLevelingClient()
    result = client.infer_hierarchy("Display\nThe display shall support HDR.", None)
    assert isinstance(result, list)
