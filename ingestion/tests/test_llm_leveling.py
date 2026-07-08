from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import BatchedRequirementClient, LlmLevelingClient, build_survey_tree
from app.workitem.model import RequirementTag, WorkItemMode, WorkItemType


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


class FakeBatchedRequirementClient:
    """Hand-written test double for the batched (whole-document) requirement
    generation call — proves build_survey_tree calls
    generate_requirements_for_document exactly once for the whole document,
    not once per node. Result defaults to one formal requirement per node,
    keyed by node_id, but can be overridden via `results` for tests that need
    to exercise the empty-list fallback path."""

    def __init__(self, results: dict[str, list[dict]] | None = None) -> None:
        self._results = results
        self.calls: list[dict[str, str]] = []

    def generate_requirements_for_document(self, blocks_by_node_id: dict[str, str]) -> dict[str, list[dict]]:
        self.calls.append(blocks_by_node_id)
        if self._results is not None:
            return self._results
        return {
            node_id: [{"text": f"The system shall handle: {text}", "tags": ["functional"]}]
            for node_id, text in blocks_by_node_id.items()
        }


def test_build_survey_tree_uses_injected_llm_client() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 2
    assert tree.nodes[0].type == WorkItemType.FEATURE
    assert tree.nodes[0].parent_local_id is None
    assert tree.nodes[1].type == WorkItemType.REQUIREMENT
    assert tree.nodes[1].parent_local_id == "0"


def test_survey_tree_nodes_have_survey_mode_and_real_fidelity_hash() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    for node in tree.nodes:
        assert node.mode == WorkItemMode.SURVEY
        assert node.fidelity_hash is not None


def test_fidelity_hash_is_stable_across_identical_calls() -> None:
    tree_a = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    tree_b = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    hashes_a = [node.fidelity_hash for node in tree_a.nodes]
    hashes_b = [node.fidelity_hash for node in tree_b.nodes]
    assert hashes_a == hashes_b


def test_llm_leveling_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: LlmLevelingClient = FakeLlmLevelingClient()
    result = client.infer_hierarchy("Display\nThe display shall support HDR.", None)
    assert isinstance(result, list)


def test_batched_requirement_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: BatchedRequirementClient = FakeBatchedRequirementClient()
    result = client.generate_requirements_for_document({"0": "Display"})
    assert isinstance(result, dict)


def test_build_survey_tree_derives_title_from_generated_requirement_not_raw_display_text() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert tree.nodes[0].title == "The system shall handle: Display"
    assert tree.nodes[1].title != "The display shall support HDR."


def test_generate_requirements_for_document_called_exactly_once_regardless_of_node_count() -> None:
    # Proves the batching actually happened (one whole-document call), not
    # just that the code compiles against the new signature — a regression
    # to a per-node call pattern would make this call count equal len(nodes).
    fake_requirement_client = FakeBatchedRequirementClient()
    build_survey_tree(_small_doc(), FakeLlmLevelingClient(), fake_requirement_client)
    assert len(fake_requirement_client.calls) == 1


def test_node_with_no_generated_requirements_falls_back_to_raw_display_text() -> None:
    fake_requirement_client = FakeBatchedRequirementClient(results={"0": [], "1": []})
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), fake_requirement_client)
    assert tree.nodes[0].description == "Display"
    assert tree.nodes[1].description == "The display shall support HDR."
    assert tree.nodes[0].description != ""
    assert tree.nodes[1].description != ""


def test_survey_tree_can_jointly_produce_every_requirement_tag_in_the_taxonomy() -> None:
    # CR6 of the corrected work plan: the original request's full taxonomy
    # (functional, non-functional, interface, performance, regulation,
    # security, safety, operation, maintenance, features,
    # behavioral/process) has 11 members (RequirementTag). No prior test
    # asserted all 11 can flow through build_survey_tree jointly — each
    # existing test only exercises 2-3 tags.
    all_tags = list(RequirementTag)
    path = "taxonomy_survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="taxonomyhash"),
        blocks=[
            Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=f"informal note {i}", source_ref=_sr(path))
            for i in range(len(all_tags))
        ],
    )

    class _FlatHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None) -> list[dict]:
            return [
                {"node_id": str(i), "type": "Requirement", "parent_id": None}
                for i in range(len(all_tags))
            ]

    requirement_client = FakeBatchedRequirementClient(
        results={
            str(i): [{"text": f"The system shall satisfy note {i}.", "tags": [tag.value]}]
            for i, tag in enumerate(all_tags)
        }
    )

    tree = build_survey_tree(doc, _FlatHierarchyClient(), requirement_client)

    produced_tags = {tag for node in tree.nodes for tag in node.tags}
    assert produced_tags == set(RequirementTag)


def test_build_survey_tree_tolerates_a_single_object_instead_of_an_array_from_infer_hierarchy() -> None:
    # Reproduces a real failure observed running the golden E2E script
    # against a real local model (llama3.2:1b): for a short outline the
    # model sometimes collapses the requested JSON ARRAY into a single JSON
    # OBJECT. Before the fix, iterating that dict in
    # hierarchy_by_node_id = {entry["node_id"]: entry for entry in hierarchy}
    # iterates its string KEYS (not the dict itself), and entry["node_id"]
    # then raises "string indices must be integers" — a whole job crash from
    # one non-compliant response shape.
    path = "single_line.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="singlehash"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="Single requirement line.", source_ref=_sr(path))],
    )

    class _SingleObjectHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None) -> dict:
            return {"node_id": "0", "type": "Requirement", "parent_id": None}

    tree = build_survey_tree(doc, _SingleObjectHierarchyClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 1
    assert tree.nodes[0].type == WorkItemType.REQUIREMENT
