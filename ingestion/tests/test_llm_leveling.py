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

    def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
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

    def generate_requirements_for_document(
        self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, list[dict]]:
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
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
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
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> dict:
            return {"node_id": "0", "type": "Requirement", "parent_id": None}

    tree = build_survey_tree(doc, _SingleObjectHierarchyClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 1
    assert tree.nodes[0].type == WorkItemType.REQUIREMENT


def test_build_survey_tree_without_area_path_skips_retrieval_entirely() -> None:
    # No area_path/embed_client/vector_store supplied -> retrieval must not
    # even be attempted. Proven by the fake raising if kb_context ever
    # arrives non-None (it never should, since retrieval was skipped).
    class _AssertingHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            assert kb_context is None
            return [{"node_id": "0", "type": "Feature", "parent_id": None}, {"node_id": "1", "type": "Requirement", "parent_id": "0"}]

    tree = build_survey_tree(_small_doc(), _AssertingHierarchyClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 2


def test_build_survey_tree_threads_kb_context_into_both_calls(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    captured: dict[str, str | None] = {}

    class _CapturingHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            captured["hierarchy_kb_context"] = kb_context
            return [{"node_id": "0", "type": "Feature", "parent_id": None}, {"node_id": "1", "type": "Requirement", "parent_id": "0"}]

    class _CapturingRequirementClient:
        def generate_requirements_for_document(
            self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
        ) -> dict[str, list[dict]]:
            captured["requirements_kb_context"] = kb_context
            return {node_id: [{"text": f"shall {text}", "tags": []}] for node_id, text in blocks_by_node_id.items()}

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: "injected KB text",
    )

    build_survey_tree(
        _small_doc(),
        _CapturingHierarchyClient(),
        _CapturingRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert captured["hierarchy_kb_context"] == "injected KB text"
    assert captured["requirements_kb_context"] == "injected KB text"


def test_build_survey_tree_calls_retrieve_context_exactly_once(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    call_count = {"n": 0}

    def _fake_retrieve_context(area_path, query_text, embed_client, vector_store, **_):
        call_count["n"] += 1
        return None

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert call_count["n"] == 1


def test_build_survey_tree_end_to_end_injects_real_ingested_kb_chunk(tmp_path) -> None:
    # Integration test: exercises the real retrieve_context + real KbVectorStore
    # (no monkeypatching of retrieve_context, unlike the tests above), proving the
    # full chain — build_survey_tree -> retrieve_context -> KbVectorStore.query ->
    # back into both LLM client calls — actually delivers a previously-ingested
    # chunk's text into kb_context, not just that each seam's contract is honored
    # in isolation.
    from app.kb.kb_vector_store import KbVectorStore

    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="source-1:spec.docx:0",
        embedding=[1.0, 0.0, 0.0],
        text="The receiver shall decode HDR10 metadata.",
        area_path="Project\\Area1",
        source_file="spec.docx",
        source_id="source-1",
        chunk_index=0,
        file_hash="hash-1",
    )

    class _FakeEmbedClient:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[1.0, 0.0, 0.0]]

    captured: dict[str, str | None] = {}

    class _CapturingHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            captured["hierarchy_kb_context"] = kb_context
            return [
                {"node_id": "0", "type": "Feature", "parent_id": None},
                {"node_id": "1", "type": "Requirement", "parent_id": "0"},
            ]

    class _CapturingRequirementClient:
        def generate_requirements_for_document(
            self, blocks_by_node_id: dict[str, str], kb_context: str | None = None
        ) -> dict[str, list[dict]]:
            captured["requirements_kb_context"] = kb_context
            return {node_id: [{"text": f"shall {text}", "tags": []}] for node_id, text in blocks_by_node_id.items()}

    build_survey_tree(
        _small_doc(),
        _CapturingHierarchyClient(),
        _CapturingRequirementClient(),
        area_path="Project\\Area1",
        embed_client=_FakeEmbedClient(),
        vector_store=store,
    )

    assert captured["hierarchy_kb_context"] == "The receiver shall decode HDR10 metadata."
    assert captured["requirements_kb_context"] == "The receiver shall decode HDR10 metadata."


class FakeBatchedScoringClient:
    """Hand-written test double for the batched (whole-document) scoring
    call — proves build_survey_tree calls score_requirements_for_document
    exactly once for the whole document, not once per node. Result
    defaults to a perfect score with no issues per node, but can be
    overridden via `results` to exercise the tolerant-parsing fallback
    paths."""

    def __init__(self, results: dict[str, dict] | None = None) -> None:
        self._results = results
        self.calls: list[dict[str, str]] = []

    def score_requirements_for_document(
        self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
    ) -> dict[str, dict]:
        self.calls.append(descriptions_by_node_id)
        if self._results is not None:
            return self._results
        return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}


def test_build_survey_tree_without_scoring_client_leaves_quality_fields_unset() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    for node in tree.nodes:
        assert node.quality_score is None
        assert node.quality_issues == []


def test_build_survey_tree_threads_scores_and_issues_into_nodes() -> None:
    from app.workitem.model import RequirementQualityIssue

    fake_scoring_client = FakeBatchedScoringClient(
        results={
            "0": {"score": 90, "issues": ["vague_term"]},
            "1": {"score": 40, "issues": ["not_testable", "compound"]},
        }
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client
    )
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["0"].quality_score == 90
    assert by_id["0"].quality_issues == [RequirementQualityIssue.VAGUE_TERM]
    assert by_id["1"].quality_score == 40
    assert sorted(i.value for i in by_id["1"].quality_issues) == ["compound", "not_testable"]


def test_build_survey_tree_calls_scoring_exactly_once_regardless_of_node_count() -> None:
    fake_scoring_client = FakeBatchedScoringClient()
    build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client)
    assert len(fake_scoring_client.calls) == 1


def test_build_survey_tree_passes_final_descriptions_not_raw_block_text_to_scoring() -> None:
    fake_scoring_client = FakeBatchedScoringClient()
    build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client)
    # FakeBatchedRequirementClient's default result is "The system shall handle: {text}"
    # — scoring must receive that FINAL formalized text, not the raw block text.
    assert fake_scoring_client.calls[0]["0"] == "The system shall handle: Display"


def test_build_survey_tree_reuses_same_kb_context_for_scoring_as_other_calls(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    captured: dict[str, str | None] = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(
            self, descriptions_by_node_id: dict[str, str], kb_context: str | None = None
        ) -> dict[str, dict]:
            captured["scoring_kb_context"] = kb_context
            return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: "injected KB text",
    )

    build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        scoring_client=_CapturingScoringClient(),
    )
    assert captured["scoring_kb_context"] == "injected KB text"


def test_build_survey_tree_tolerates_malformed_score_and_issues_per_node() -> None:
    # A non-int score, an out-of-range score, a non-list issues value, and an
    # issue string outside RequirementQualityIssue must each fall back
    # gracefully — never crash, never affect sibling nodes.
    fake_scoring_client = FakeBatchedScoringClient(
        results={
            "0": {"score": "not-a-number", "issues": "not-a-list"},
            "1": {"score": 150, "issues": ["not_testable", "made_up_issue"]},
        }
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client
    )
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["0"].quality_score is None
    assert by_id["0"].quality_issues == []
    assert by_id["1"].quality_score is None  # 150 is out of the 0-100 range
    assert [i.value for i in by_id["1"].quality_issues] == ["not_testable"]


def test_build_survey_tree_rejects_boolean_score_values() -> None:
    # A boolean score must be rejected even though bool is a subclass of int
    # in Python — `isinstance(True, int)` returns True, but the guard
    # explicitly checks `not isinstance(raw_score, bool)` to prevent confusion
    # between True/False (semantic booleans) and valid 0-100 integer scores.
    fake_scoring_client = FakeBatchedScoringClient(
        results={
            "0": {"score": True, "issues": []},
            "1": {"score": 85, "issues": []},
        }
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client
    )
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["0"].quality_score is None  # bool is rejected despite isinstance(True, int) == True
    assert by_id["1"].quality_score == 85


def test_build_survey_tree_tolerates_a_non_dict_per_node_scoring_entry() -> None:
    # Reproduces what happens if a caller's LLM proxy mock/fixture returns a
    # value shaped like generate_requirements_for_document's response (a
    # list) instead of scoring's {"score":.., "issues":..} dict for some
    # node_id — must be treated as "no entry", not crash on list.get(...).
    fake_scoring_client = FakeBatchedScoringClient(results={"0": [{"text": "wrong shape"}]})
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client=fake_scoring_client
    )
    node0 = next(node for node in tree.nodes if node.local_id == "0")
    assert node0.quality_score is None
    assert node0.quality_issues == []
