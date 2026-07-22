from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling.llm_leveling import BatchedRequirementClient, LlmLevelingClient, build_survey_tree
from app.workitem.model import KbCitationRelevance
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

    def generate_requirements_for_document(self, blocks_by_node_id: dict[str, str], kb_context: str | None = None) -> dict[str, list[dict]]:
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


def test_build_survey_tree_stamps_customer_id_on_every_node() -> None:
    # Regression: build_survey_tree previously had no customer_id parameter
    # at all -- /level silently dropped the job's customer_id for every
    # SURVEY-mode node (always None), unlike build_baseline_tree, which
    # threads it correctly. confirm()'s Customer ID field resolution was
    # therefore never reachable for a SURVEY job.
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), customer_id="CUST-042"
    )
    assert len(tree.nodes) == 2
    assert all(n.customer_id == "CUST-042" for n in tree.nodes)


def test_build_survey_tree_stamps_customer_id_across_multiple_branches() -> None:
    # Same as above, but for the multi-branch path (_build_survey_tree_for_branch
    # called once per branch) -- customer_id must reach every branch's nodes.
    class TwoBranchLlmLevelingClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            return [{"node_id": "0", "type": "Feature", "parent_id": None}]

    path = "two_branch.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Branch A", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.HEADING, heading_level=1, text="Branch B", source_ref=_sr(path)),
        ],
    )
    tree = build_survey_tree(
        doc, TwoBranchLlmLevelingClient(), FakeBatchedRequirementClient(), customer_id="CUST-042"
    )
    assert len(tree.nodes) == 2
    assert all(n.customer_id == "CUST-042" for n in tree.nodes)


def test_build_survey_tree_defaults_customer_id_to_none() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert all(n.customer_id is None for n in tree.nodes)


def test_build_survey_tree_has_no_warnings_when_node_count_matches_block_count() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert tree.warnings == []


def test_build_survey_tree_warns_when_hierarchy_drops_most_of_the_document() -> None:
    # Regression: nothing previously compared the LLM's output against the
    # input document's blocks at anything finer than an aggregate count --
    # a document whose second half got silently dropped looked identical (no
    # error, no log) to a correctly-processed one. Each block below uses
    # genuinely distinct vocabulary (a realistic scenario, not placeholder
    # "Req N" text sharing the literal word "req") so the per-block coverage
    # check can tell "truly dropped" apart from "merged into another node".
    class DroppingLlmLevelingClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            # 5 real blocks in the doc, but only 1 comes back -- an 80% drop.
            return [{"node_id": "0", "type": "Feature", "parent_id": None}]

    path = "big.txt"
    texts = [
        "The display shall support HDR playback.",
        "The receiver shall log all firmware errors.",
        "The unit shall survive a one-meter drop.",
        "The fan shall activate above forty-five degrees.",
        "The battery shall charge fully within two hours.",
    ]
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=t, source_ref=_sr(path)) for i, t in enumerate(texts)],
    )
    tree = build_survey_tree(doc, DroppingLlmLevelingClient(), FakeBatchedRequirementClient())
    assert len(tree.warnings) == 1
    assert "did not reference 4 of 5 source block(s)" in tree.warnings[0]
    assert "['1', '2', '3', '4']" in tree.warnings[0]


def test_build_survey_tree_does_not_warn_when_a_dropped_node_ids_content_was_merged_elsewhere() -> None:
    # A block the LLM never gave its own node_id to is NOT flagged as
    # dropped if its content still shows up (even paraphrased) in another
    # node's generated text -- a legitimate merge, not data loss.
    class MergingLlmLevelingClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            return [{"node_id": "0", "type": "Feature", "parent_id": None}]

    class MergingRequirementClient:
        def generate_requirements_for_document(self, blocks_by_node_id: dict[str, str], kb_context: str | None = None) -> dict[str, list[dict]]:
            return {
                "0": [
                    {
                        "text": "The display shall support HDR playback and the receiver shall log all firmware errors.",
                        "tags": [],
                    }
                ]
            }

    path = "merged.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The display shall support HDR playback.", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The receiver shall log all firmware errors.", source_ref=_sr(path)),
        ],
    )
    tree = build_survey_tree(doc, MergingLlmLevelingClient(), MergingRequirementClient())
    assert tree.warnings == []


def test_build_survey_tree_warns_and_discards_a_hallucinated_node_id() -> None:
    # Regression: a fabricated node_id not present in the source document
    # was silently filtered out downstream with zero error/count surfaced.
    class HallucinatingLlmLevelingClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            return [
                {"node_id": "0", "type": "Feature", "parent_id": None},
                {"node_id": "1", "type": "Requirement", "parent_id": "0"},
                {"node_id": "99", "type": "Requirement", "parent_id": "0"},  # does not exist in the doc
            ]

    tree = build_survey_tree(_small_doc(), HallucinatingLlmLevelingClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 2  # the hallucinated node_id "99" never became a real node
    assert any("99" in w and "not present in the source document" in w for w in tree.warnings)


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


def _two_branch_doc() -> CanonicalDoc:
    # Two top-level (depth-1) headings -> _split_into_branches produces two
    # independent branches, each with its own heading + one requirement.
    path = "two_branch_survey_input.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )


class _PerBranchHierarchyClient:
    """Records every outline it was called with -- proves build_survey_tree
    calls infer_hierarchy once PER BRANCH (each with only that branch's own
    blocks), not once for the whole document."""

    def __init__(self) -> None:
        self.outlines: list[str] = []

    def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
        self.outlines.append(outline)
        # Each branch has exactly 2 blocks (heading + one requirement),
        # locally indexed "0"/"1" within that branch's own outline.
        return [
            {"node_id": "0", "type": "Feature", "parent_id": None},
            {"node_id": "1", "type": "Requirement", "parent_id": "0"},
        ]


def test_build_survey_tree_chunks_a_multi_branch_document_into_one_call_per_branch() -> None:
    # Regression: infer_hierarchy/generate_requirements_for_document
    # previously always sent the ENTIRE document in one call regardless of
    # size, risking context-window overflow on a large/deep document.
    llm_client = _PerBranchHierarchyClient()
    requirement_client = FakeBatchedRequirementClient()

    tree = build_survey_tree(_two_branch_doc(), llm_client, requirement_client)

    assert len(llm_client.outlines) == 2  # one infer_hierarchy call per branch, not one for the whole doc
    assert "Display" in llm_client.outlines[0]
    assert "Audio" not in llm_client.outlines[0]  # branch 1's outline must not leak branch 2's content
    assert "Audio" in llm_client.outlines[1]
    assert len(requirement_client.calls) == 2  # one generate_requirements_for_document call per branch too


def test_build_survey_tree_namespaces_node_ids_per_branch_to_avoid_collisions() -> None:
    llm_client = _PerBranchHierarchyClient()
    requirement_client = FakeBatchedRequirementClient()

    tree = build_survey_tree(_two_branch_doc(), llm_client, requirement_client)

    assert len(tree.nodes) == 4
    local_ids = {node.local_id for node in tree.nodes}
    # Both branches' LLM responses used the same local node_ids ("0", "1") --
    # without namespacing these would collide into only 2 distinct nodes.
    assert local_ids == {"br0_0", "br0_1", "br1_0", "br1_1"}
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["br0_1"].parent_local_id == "br0_0"  # parent reference namespaced to the SAME branch
    assert by_id["br1_1"].parent_local_id == "br1_0"
    assert by_id["br0_0"].parent_local_id is None
    assert by_id["br1_0"].parent_local_id is None


def test_build_survey_tree_single_branch_document_keeps_unprefixed_node_ids() -> None:
    # A document with no heading structure at all (or exactly one top-level
    # section) has exactly ONE branch -- chunking must be invisible here,
    # producing the exact same node_ids as before this change existed.
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    local_ids = {node.local_id for node in tree.nodes}
    assert local_ids == {"0", "1"}


def test_build_survey_tree_scores_a_well_grounded_generated_description_highly() -> None:
    # The default FakeBatchedRequirementClient's generated text
    # ("The system shall handle: <source text>") is a genuine paraphrase
    # that reuses the source's own significant vocabulary -- should score
    # well above the low-grounding threshold, no warning.
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    for node in tree.nodes:
        assert node.grounding_score is not None
        assert node.grounding_score >= 0.5
    assert tree.warnings == []


def test_build_survey_tree_flags_a_generated_description_unrelated_to_its_source() -> None:
    # Regression: generated text was previously trusted verbatim with ZERO
    # comparison against the source block it supposedly formalized -- the
    # model could invent unrelated content and it would flow straight
    # through with no signal at all.
    requirement_client = FakeBatchedRequirementClient(
        results={
            "0": [{"text": "The warranty period is thirty-six months from purchase.", "tags": ["functional"]}],
            "1": [{"text": "The warranty period is thirty-six months from purchase.", "tags": ["functional"]}],
        }
    )
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), requirement_client)
    assert any(node.grounding_score is not None and node.grounding_score < 0.2 for node in tree.nodes)
    assert any("low grounding" in w for w in tree.warnings)


def test_build_survey_tree_grounding_score_is_1_for_the_raw_display_text_fallback() -> None:
    # A node with no generated requirement at all falls back to the raw
    # display text verbatim -- it IS its own source, trivially fully grounded.
    requirement_client = FakeBatchedRequirementClient(results={})  # no generated text for any node
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), requirement_client)
    assert all(node.grounding_score == 1.0 for node in tree.nodes)


class FakeScoringClient:
    """Hand-written test double for BatchedScoringClient -- proves
    build_survey_tree calls score_requirements_for_document exactly once
    per branch, only when a scoring_client is actually supplied."""

    def __init__(self, results: dict[str, dict] | None = None) -> None:
        self._results = results
        self.calls: list[dict[str, str]] = []
        self.criteria_contexts: list[str | None] = []

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
    ) -> dict[str, dict]:
        self.calls.append(descriptions_by_node_id)
        self.criteria_contexts.append(criteria_context)
        if self._results is not None:
            return self._results
        return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}


def test_build_survey_tree_does_not_score_when_no_scoring_client_is_supplied() -> None:
    # scoring_client defaults to None -- every pre-existing call site needs
    # zero changes, and every node's quality_score/quality_issues stay at
    # their model defaults.
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    for node in tree.nodes:
        assert node.quality_score is None
        assert node.quality_issues == []


def test_build_survey_tree_scores_every_node_when_a_scoring_client_is_supplied() -> None:
    scoring_client = FakeScoringClient()
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client)

    assert len(scoring_client.calls) == 1  # one batched call, not one per node
    assert set(scoring_client.calls[0].keys()) == {"0", "1"}
    for node in tree.nodes:
        assert node.quality_score == 90
        assert node.quality_issues == []


def test_build_survey_tree_passes_none_criteria_context_when_no_retriever_is_supplied() -> None:
    # Backward-compat: criteria_retriever is entirely optional, same as
    # scoring_client -- omitted must be byte-identical to before this
    # capability existed (score_requirements_for_document sees
    # criteria_context=None).
    scoring_client = FakeScoringClient()
    build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client)

    assert scoring_client.criteria_contexts == [None]


def test_build_survey_tree_grounds_scoring_with_retrieved_criteria_when_a_retriever_is_supplied() -> None:
    from app.quality.criteria_corpus import CRITERIA_CORPUS

    class FakeCriteriaRetriever:
        def __init__(self) -> None:
            self.queries: list[str] = []

        def retrieve(self, query_text: str, top_k: int = 3):
            self.queries.append(query_text)
            return CRITERIA_CORPUS[:1]

    scoring_client = FakeScoringClient()
    retriever = FakeCriteriaRetriever()
    build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        scoring_client,
        criteria_retriever=retriever,
    )

    assert len(retriever.queries) == 1  # one retrieve() call per branch, not per node
    assert scoring_client.criteria_contexts[0] is not None
    assert CRITERIA_CORPUS[0].text in scoring_client.criteria_contexts[0]


def test_build_survey_tree_records_quality_issues_from_the_closed_vocabulary_only() -> None:
    scoring_client = FakeScoringClient(
        results={
            "0": {"score": 40, "issues": ["ambiguous", "not_a_real_issue"]},
            "1": {"score": 95, "issues": []},
        }
    )
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client)

    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["0"].quality_score == 40
    assert [i.value for i in by_id["0"].quality_issues] == ["ambiguous"]  # unknown issue silently dropped
    assert by_id["1"].quality_score == 95


def test_build_survey_tree_falls_back_to_none_for_a_missing_or_malformed_score_and_warns() -> None:
    # Tolerant of LLM non-compliance: a missing/malformed entry for one
    # node_id must not crash the batch or affect sibling nodes.
    scoring_client = FakeScoringClient(
        results={
            "0": {"score": 150, "issues": []},  # out of 0-100 range
            # "1" missing entirely
        }
    )
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(), scoring_client)

    for node in tree.nodes:
        assert node.quality_score is None
    assert any("no valid score" in w for w in tree.warnings)


def test_build_survey_tree_rejects_boolean_score_values() -> None:
    # A boolean score must be rejected even though bool is a subclass of int
    # in Python — `isinstance(True, int)` returns True, but the guard
    # explicitly checks `not isinstance(raw_score, bool)` to prevent confusion
    # between True/False (semantic booleans) and valid 0-100 integer scores.
    fake_scoring_client = FakeScoringClient(
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


def test_build_survey_tree_calls_scoring_once_per_branch_for_a_multi_branch_document() -> None:
    scoring_client = FakeScoringClient()
    tree = build_survey_tree(
        _two_branch_doc(), _PerBranchHierarchyClient(), FakeBatchedRequirementClient(), scoring_client
    )
    assert len(scoring_client.calls) == 2  # one per branch, not one for the whole document


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


def test_build_survey_tree_defaults_an_invalid_hierarchy_type_to_requirement() -> None:
    # Reproduces a real failure observed running SURVEY mode against a real
    # local model (gemma4:e4b): the prompt explicitly lists "one of: Epic,
    # Feature, Requirement", but the model returned "Recommendation" for one
    # node anyway. Before the fix, WorkItemType(entry["type"]) raised an
    # unhandled ValueError, crashing the entire job over one hallucinated
    # type on one node.
    path = "single_line.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="singlehash"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="Single requirement line.", source_ref=_sr(path))],
    )

    class _InvalidTypeHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            return [{"node_id": "0", "type": "Recommendation", "parent_id": None}]

    tree = build_survey_tree(doc, _InvalidTypeHierarchyClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 1
    assert tree.nodes[0].type == WorkItemType.REQUIREMENT
    assert any("invalid type" in w for w in tree.warnings)


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
        lambda area_path, query_text, embed_client, vector_store, **_: (
        "injected KB text",
        [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "injected KB text"}],
    ),
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
        return None, []

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

    tree = build_survey_tree(
        _small_doc(),
        _CapturingHierarchyClient(),
        _CapturingRequirementClient(),
        area_path="Project\\Area1",
        embed_client=_FakeEmbedClient(),
        vector_store=store,
    )

    assert captured["hierarchy_kb_context"] == "The receiver shall decode HDR10 metadata."
    assert captured["requirements_kb_context"] == "The receiver shall decode HDR10 metadata."
    assert [c.source_file for c in tree.kb_citations] == ["spec.docx"]


def test_build_survey_tree_reuses_same_kb_context_for_scoring_as_other_calls(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    captured: dict[str, str | None] = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(
            self, descriptions_by_node_id: dict[str, str], criteria_context: str | None = None, kb_context: str | None = None
        ) -> dict[str, dict]:
            captured["scoring_kb_context"] = kb_context
            return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (
        "injected KB text",
        [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "injected KB text"}],
    ),
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


def test_build_survey_tree_without_area_path_has_empty_kb_citations() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert tree.kb_citations == []


def test_build_survey_tree_threads_kb_citations_from_retrieve_context(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (
        "injected KB text",
        [
            {"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"},
            {"source_file": "doc-b.pdf", "distance": 0.2, "similarity": 0.8, "text": "chunk b"},
        ],
    ),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert [c.source_file for c in tree.kb_citations] == ["doc-a.docx", "doc-b.pdf"]


def test_build_survey_tree_kb_citations_empty_when_retrieval_finds_nothing(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (None, []),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations == []


def test_build_survey_tree_kb_citations_stay_unknown_relevance_when_no_relevance_client(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"}],
        ),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations[0].relevance == KbCitationRelevance.UNKNOWN


def test_build_survey_tree_kb_citations_get_verified_relevance_when_relevance_client_supplied(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [
                {"source_file": "relevant.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"},
                {"source_file": "irrelevant.docx", "distance": 0.2, "similarity": 0.8, "text": "chunk b"},
            ],
        ),
    )

    class _FakeKbRelevanceClient:
        def judge_kb_relevance(self, branch_content: str, snippets: list[dict]) -> dict[str, str]:
            return {"0": "relevant", "1": "not_relevant"}

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        kb_relevance_client=_FakeKbRelevanceClient(),
    )
    by_file = {c.source_file: c.relevance for c in tree.kb_citations}
    assert by_file["relevant.docx"] == KbCitationRelevance.RELEVANT
    assert by_file["irrelevant.docx"] == KbCitationRelevance.NOT_RELEVANT


def test_build_survey_tree_kb_citations_degrade_to_unknown_when_relevance_client_raises(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"}],
        ),
    )

    class _RaisingKbRelevanceClient:
        def judge_kb_relevance(self, branch_content: str, snippets: list[dict]) -> dict[str, str]:
            raise RuntimeError("orchestrator unreachable")

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        area_path="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        kb_relevance_client=_RaisingKbRelevanceClient(),
    )
    assert tree.kb_citations[0].relevance == KbCitationRelevance.UNKNOWN


class FakeTraceLinkInferenceClient:
    """Hand-written test double for infer_trace_links — proves build_survey_tree
    calls it exactly once per document (whole-tree, not per-node), and that
    the discovered catalog is passed through unchanged."""

    def __init__(self, results: list[dict] | None = None) -> None:
        self._results = results if results is not None else []
        self.calls: list[dict] = []

    def infer_trace_links(self, nodes: list[dict], link_type_catalog: list[dict], kb_context: str | None = None) -> list[dict]:
        self.calls.append({"nodes": nodes, "link_type_catalog": link_type_catalog, "kb_context": kb_context})
        return self._results


def test_build_survey_tree_without_link_type_client_leaves_trace_links_empty() -> None:
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert tree.trace_links == []


def test_build_survey_tree_calls_infer_trace_links_exactly_once_with_the_catalog() -> None:
    fake_client = FakeTraceLinkInferenceClient()
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}]
    build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(fake_client.calls) == 1
    assert fake_client.calls[0]["link_type_catalog"] == catalog


def test_build_survey_tree_resolves_intra_job_link_target() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "1", "target_ref": "0", "reference_name": "System.LinkTypes.Related"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=[],
    )
    assert len(tree.trace_links) == 1
    link = tree.trace_links[0]
    assert link.source_local_id == "1"
    assert link.target_kind == "intraJob"
    assert link.target_local_id == "0"
    assert link.resolution_status == "pending"


def test_build_survey_tree_treats_a_non_node_id_target_ref_as_cross_job_customer_id() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "1", "target_ref": "REQ-SYS-012", "reference_name": "Elisra.CoveredBy-Reverse"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=[],
    )
    link = tree.trace_links[0]
    assert link.target_kind == "crossJob"
    assert link.target_customer_id == "REQ-SYS-012"
    assert link.target_local_id is None


def test_build_survey_tree_drops_a_link_with_a_reference_name_not_in_the_catalog() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[
            {"source_node_id": "1", "target_ref": "0", "reference_name": "Hallucinated.NotReal"},
            {"source_node_id": "1", "target_ref": "0", "reference_name": "System.LinkTypes.Related"},
        ]
    )
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}]
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(tree.trace_links) == 1
    assert tree.trace_links[0].reference_name == "System.LinkTypes.Related"


def test_build_survey_tree_drops_a_link_whose_source_node_id_does_not_exist() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "does-not-exist", "target_ref": "0", "reference_name": "System.LinkTypes.Related"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient(),
        link_type_client=fake_client, link_type_catalog=[{"reference_name": "System.LinkTypes.Related", "name": "Related"}],
    )
    assert tree.trace_links == []


def test_build_survey_tree_bounds_an_oversized_top_level_branch_into_multiple_llm_calls(monkeypatch) -> None:
    # Reproduces a real failure: a document can have very few top-level
    # sections (here, deliberately just one) that are themselves still too
    # large for a single per-branch LLM call. build_survey_tree must bound
    # branch size directly (_bound_branch_size), not rely solely on the
    # document's own heading structure -- proven here by lowering the bound
    # low enough that this modest synthetic doc still must be split into
    # more than one infer_hierarchy call.
    import app.leveling.llm_leveling as llm_leveling_module

    monkeypatch.setattr(llm_leveling_module, "_MAX_SURVEY_BRANCH_BLOCK_COUNT", 3)

    path = "one_big_section.txt"
    blocks = [Block(id="b0", kind=BlockKind.PARAGRAPH, text="2 Title", source_ref=_sr(path))]
    for i in range(1, 7):
        blocks.append(Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=f"2.{i} The system shall do thing {i}.", source_ref=_sr(path)))
    doc = CanonicalDoc(document=Document(path=path, format=DocumentFormat.TXT, sha256="h"), blocks=blocks)

    call_count = 0

    class _CountingHierarchyClient:
        def infer_hierarchy(self, outline: str, profile_hint: str | None, kb_context: str | None = None) -> list[dict]:
            nonlocal call_count
            call_count += 1
            lines = outline.strip().split("\n")
            return [{"node_id": str(i), "type": "Requirement", "parent_id": None} for i in range(len(lines))]

    tree = build_survey_tree(doc, _CountingHierarchyClient(), FakeBatchedRequirementClient())

    # Without bounding, this single-top-level-branch document would produce
    # exactly ONE infer_hierarchy call for all 7 blocks.
    assert call_count > 1
    # Every source block must still end up represented somewhere in the
    # tree -- bounding must never silently drop content.
    assert len(tree.nodes) == 7


def test_build_survey_tree_fires_progress_callback_for_each_real_step_boundary() -> None:
    events = []

    tree = build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        progress_callback=lambda p: events.append(p),
    )

    phases = [e.phase for e in events]
    assert phases == ["infer_hierarchy", "generate_requirements"]
    assert all(e.branch_index == 0 for e in events)
    assert all(e.branch_count == 1 for e in events)
    assert all(e.blocks_total == len(tree.nodes) or e.blocks_total >= 0 for e in events)
    assert all(e.kb_grounded is False for e in events)


def test_build_survey_tree_progress_callback_fires_score_requirements_when_scoring_client_present() -> None:
    events = []

    class _FakeScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None):
            return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}

    build_survey_tree(
        _small_doc(),
        FakeLlmLevelingClient(),
        FakeBatchedRequirementClient(),
        scoring_client=_FakeScoringClient(),
        progress_callback=lambda p: events.append(p),
    )

    assert [e.phase for e in events] == ["infer_hierarchy", "generate_requirements", "score_requirements"]


def test_build_survey_tree_progress_callback_never_fires_when_omitted() -> None:
    # Regression guard: progress_callback is entirely optional -- omitting it
    # (every pre-existing caller) must not attempt to call None.
    tree = build_survey_tree(_small_doc(), FakeLlmLevelingClient(), FakeBatchedRequirementClient())
    assert len(tree.nodes) == 2
