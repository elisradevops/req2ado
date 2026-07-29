from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table
from app.leveling.llm_leveling import SectionAnalysisClient, _grounding_score, build_survey_tree, render_section
from app.workitem.model import KbCitationRelevance
from app.workitem.model import RequirementTag, WorkItemMode, WorkItemType


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _force_multi_branch(monkeypatch) -> None:
    """§3's whole-document gate skips branch-splitting entirely when the
    rendered document fits the model's token budget -- true for every tiny
    synthetic doc in this file under the default (model=None) budget. Tests
    that specifically exercise multi-branch/budget-merge behavior force the
    "doesn't fit" path by making _estimate_tokens report an impossibly large
    size, independent of the real budget-gate/merge logic under test."""
    import app.leveling.llm_leveling as llm_leveling_module

    monkeypatch.setattr(llm_leveling_module, "_estimate_tokens", lambda text: 10_000_000)


def _small_doc() -> CanonicalDoc:
    path = "survey_input.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )


# Default node set for FakeSectionAnalysisClient: mirrors the old two-call
# default's paraphrase pattern ("The system shall handle: <source text>") so
# grounding/title tests behave the same way -- one Feature root + one
# Requirement child, same shape most tests below rely on.
_DEFAULT_NODES = [
    {
        "temp_id": "n0", "type": "Feature", "parent_temp_id": None,
        "title": "Display", "text": "The system shall handle: Display", "tags": ["functional"],
    },
    {
        "temp_id": "n1",
        "type": "Requirement",
        "parent_temp_id": "n0",
        "title": "HDR support",
        "text": "The system shall handle: The display shall support HDR.",
        "tags": ["functional"],
    },
]


class FakeSectionAnalysisClient:
    """Test double for SectionAnalysisClient -- the one-call holistic SURVEY
    redesign replacing the old LlmLevelingClient + BatchedRequirementClient
    pair. Records every call for call-count/threading assertions.
    `analyze_section` (fallback path) and `analyze_section_agentic`
    (tool-capable path, see _resolve_caps) are tracked separately so tests
    can assert build_survey_tree's §5c gate picked the right one."""

    def __init__(
        self,
        nodes: list[dict] | None = None,
        agentic_nodes: list[dict] | None = None,
        agentic_citations: list[dict] | None = None,
        truncated: bool = False,
    ) -> None:
        self._nodes = nodes if nodes is not None else _DEFAULT_NODES
        self._agentic_nodes = agentic_nodes if agentic_nodes is not None else self._nodes
        self._agentic_citations = agentic_citations if agentic_citations is not None else []
        self._truncated = truncated
        self.calls: list[dict] = []
        self.agentic_calls: list[dict] = []

    def analyze_section(
        self, section_text: str, kb_context: str | None = None, whole_document: bool = False,
        topic_count: int | None = None,
    ) -> tuple[list[dict], bool]:
        self.calls.append({
            "section_text": section_text, "kb_context": kb_context,
            "whole_document": whole_document, "topic_count": topic_count,
        })
        return self._nodes, self._truncated

    def analyze_section_agentic(
        self, section_text: str, retrieve_fn, list_documents_fn=None, read_document_fn=None,
        read_other_section_fn=None, whole_document: bool = False, topic_count: int | None = None,
    ) -> tuple[list[dict], list[dict], bool]:
        self.agentic_calls.append(
            {
                "section_text": section_text,
                "retrieve_fn": retrieve_fn,
                "list_documents_fn": list_documents_fn,
                "read_document_fn": read_document_fn,
                "read_other_section_fn": read_other_section_fn,
                "whole_document": whole_document,
                "topic_count": topic_count,
            }
        )
        return self._agentic_nodes, self._agentic_citations, self._truncated


def test_build_survey_tree_uses_injected_analysis_client() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert len(tree.nodes) == 2
    assert tree.nodes[0].type == WorkItemType.FEATURE
    assert tree.nodes[0].parent_local_id is None
    assert tree.nodes[1].type == WorkItemType.REQUIREMENT
    assert tree.nodes[1].parent_local_id == "n0"


def test_build_survey_tree_stamps_customer_id_on_every_node() -> None:
    # Regression: build_survey_tree previously had no customer_id parameter
    # at all -- /level silently dropped the job's customer_id for every
    # SURVEY-mode node (always None), unlike build_baseline_tree, which
    # threads it correctly. confirm()'s Customer ID field resolution was
    # therefore never reachable for a SURVEY job.
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), customer_id="CUST-042")
    assert len(tree.nodes) == 2
    assert all(n.customer_id == "CUST-042" for n in tree.nodes)


def test_build_survey_tree_stamps_customer_id_across_multiple_branches(monkeypatch) -> None:
    # Same as above, but for the multi-branch path (_build_survey_tree_for_branch
    # called once per branch) -- customer_id must reach every branch's nodes.
    _force_multi_branch(monkeypatch)
    tree = build_survey_tree(_two_branch_doc(), FakeSectionAnalysisClient(), customer_id="CUST-042")
    assert len(tree.nodes) == 4  # 2 nodes/branch x 2 branches
    assert all(n.customer_id == "CUST-042" for n in tree.nodes)


def test_build_survey_tree_defaults_customer_id_to_none() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert all(n.customer_id is None for n in tree.nodes)


def test_build_survey_tree_has_no_warnings_when_node_count_matches_block_count() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert tree.warnings == []


def test_build_survey_tree_warns_when_analysis_drops_most_of_the_document() -> None:
    # Regression: nothing previously compared the LLM's output against the
    # input document's blocks at anything finer than an aggregate count --
    # a document whose second half got silently dropped looked identical (no
    # error, no log) to a correctly-processed one. Each block below uses
    # genuinely distinct vocabulary (a realistic scenario, not placeholder
    # "Req N" text sharing the literal word "req") so the per-block coverage
    # check can tell "truly dropped" apart from "merged into another node".
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
    # Only one node returned, covering just the first block's content --
    # blocks 1-4's distinct vocabulary never appears anywhere in the output.
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Display", "text": texts[0], "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert len(tree.warnings) == 1
    assert "did not reference 4 of 5 source block(s)" in tree.warnings[0]
    assert "[1, 2, 3, 4]" in tree.warnings[0]
    # Regression: a bare index list forced a reviewer to go dig up the raw
    # parsed document to judge whether a dropped block was a real loss or
    # benign non-requirement content -- a text preview per index answers
    # that right in the warning itself.
    assert '[1] "The receiver shall log all firmware errors."' in tree.warnings[0]
    assert '[4] "The battery shall charge fully within two hours."' in tree.warnings[0]


def test_build_survey_tree_does_not_warn_when_a_dropped_blocks_content_was_merged_elsewhere() -> None:
    # A block with no node of its own is NOT flagged as dropped if its
    # content still shows up (even paraphrased) in another node's generated
    # text -- a legitimate merge, not data loss.
    path = "merged.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The display shall support HDR playback.", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The receiver shall log all firmware errors.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[
            {
                "temp_id": "n0",
                "type": "Feature",
                "parent_temp_id": None,
                "title": "Display and firmware logging",
                "text": "The display shall support HDR playback and the receiver shall log all firmware errors.",
                "tags": [],
            }
        ]
    )
    tree = build_survey_tree(doc, fake)
    assert tree.warnings == []


def test_build_survey_tree_does_not_flag_a_short_label_block_as_dropped() -> None:
    # §10.3 fix: a 1-2-significant-word block (a structural label like
    # "APOLLO2" or "Notes:") can never realistically re-appear verbatim
    # inside a synthesized shall-statement even when correctly absorbed as
    # context, not restated -- the coverage check must not flag it.
    path = "short_labels.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="APOLLO2", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Notes:", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="The unit shall boot within ten seconds.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "Boot time", "text": "The unit shall boot within ten seconds.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert tree.warnings == []


def test_build_survey_tree_skips_a_figure_the_vision_model_flagged_as_no_content() -> None:
    # §10.2a fix: a figure whose caption is exactly the NO_TECHNICAL_CONTENT
    # sentinel (the vision model correctly saying there was nothing to
    # describe) must not be flagged as a "dropped" block -- there was
    # nothing to lose.
    from app.vision.orchestrator_vision_client import NO_TECHNICAL_CONTENT_SENTINEL

    path = "empty_figure.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The unit shall boot within ten seconds.", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.FIGURE, text=f"[FIGURE: {NO_TECHNICAL_CONTENT_SENTINEL}]", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "Boot time", "text": "The unit shall boot within ten seconds.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert tree.warnings == []


def test_build_survey_tree_falls_back_dangling_parent_temp_id_to_root_and_warns() -> None:
    # Regression (§2c step 5): the model can reference a parent_temp_id that
    # doesn't exist in its own returned node set -- previously this had no
    # handling at all under the new temp_id-keyed mapping. Must not crash;
    # falls back to a section root with a reviewable warning. The CMMI
    # hierarchy repair (added later) then ALSO catches this specific case --
    # a root-level Requirement with a real Feature already present in the
    # branch is itself a hierarchy violation, so n1 ends up re-parented
    # under the Feature rather than staying a root. Both warnings fire.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "text": "Root requirement.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "does-not-exist", "text": "Orphan requirement.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 2
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n1"].parent_local_id == "n0"  # repaired under the real Feature, not left orphaned
    assert any("does-not-exist" in w and "attached as section root" in w for w in tree.warnings)
    assert any("re-parented under Feature n0" in w for w in tree.warnings)


def test_survey_tree_nodes_have_survey_mode_and_real_fidelity_hash() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    for node in tree.nodes:
        assert node.mode == WorkItemMode.SURVEY
        assert node.fidelity_hash is not None


def test_fidelity_hash_is_stable_across_identical_calls() -> None:
    tree_a = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    tree_b = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    hashes_a = [node.fidelity_hash for node in tree_a.nodes]
    hashes_b = [node.fidelity_hash for node in tree_b.nodes]
    assert hashes_a == hashes_b


def test_section_analysis_client_is_a_protocol_satisfied_by_the_fake() -> None:
    client: SectionAnalysisClient = FakeSectionAnalysisClient()
    nodes, truncated = client.analyze_section("Display\nThe display shall support HDR.")
    assert isinstance(nodes, list)
    assert truncated is False


def test_build_survey_tree_uses_the_models_own_title_not_the_full_description() -> None:
    # Real title distillation: the model returns a short 'title' distinct
    # from the full formal 'text' -- title must NOT just be a truncated/
    # verbatim copy of the description (the pre-distillation behavior).
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert tree.nodes[0].title == "Display"
    assert tree.nodes[0].description == "The system shall handle: Display"
    assert tree.nodes[1].title == "HDR support"
    assert tree.nodes[1].title != tree.nodes[1].description


def test_build_survey_tree_falls_back_to_description_derived_title_when_model_omits_title() -> None:
    # Tolerant of LLM non-compliance: schema marks 'title' required, but a
    # model can still omit it -- must degrade to the pre-distillation
    # behavior (title derived from the full text) with a warning, not crash.
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "text": "The system shall power on.", "tags": []}]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert tree.nodes[0].title == "The system shall power on."
    assert any("had no model title" in w for w in tree.warnings)


def test_build_survey_tree_truncates_an_overlong_model_title() -> None:
    long_title = "T" * 300
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": long_title, "text": "The system shall power on.", "tags": []}]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes[0].title) <= 256


def test_analyze_section_called_exactly_once_per_branch() -> None:
    # Proves the holistic design actually happened (one whole-section call),
    # not one call per node -- a regression to a per-node call pattern would
    # make this call count scale with node/block count.
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_small_doc(), fake)
    assert len(fake.calls) == 1


def test_build_survey_tree_passes_whole_document_true_for_a_single_call_document() -> None:
    # A tiny doc with no headings fits the whole-document gate trivially --
    # global_context stays None, so whole_document must be True.
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_small_doc(), fake)
    assert fake.calls[0]["whole_document"] is True


def test_build_survey_tree_passes_zero_topic_count_for_a_headingless_document() -> None:
    # _small_doc() has zero HEADING blocks (both PARAGRAPH) -- the
    # quantitative hint has nothing real to count, so topic_count must be 0
    # (not None -- heading_count is always computed, just happens to be 0),
    # which orchestrator_llm_client._whole_document_hint treats as "fall
    # back to the qualitative-only hint".
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_small_doc(), fake)
    assert fake.calls[0]["topic_count"] == 0


def test_build_survey_tree_passes_the_real_heading_count_as_topic_count() -> None:
    # A document with real headings that STILL fits the whole-doc gate
    # (small enough overall) must pass the ACTUAL heading count, not a
    # placeholder -- the quantitative coverage hint's floor is only
    # meaningful when tied to the document's own real structure.
    path = "three_heading_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
            Block(id="b4", kind=BlockKind.HEADING, heading_level=1, text="Power", source_ref=_sr(path)),
            Block(id="b5", kind=BlockKind.PARAGRAPH, text="The unit shall support 12V input.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["whole_document"] is True  # small enough to still fit in one call
    assert fake.calls[0]["topic_count"] == 3


def test_build_survey_tree_passes_whole_document_false_for_a_multi_branch_document(monkeypatch) -> None:
    # Once the document doesn't fit in one call, every branch gets the
    # compact outline (global_context) instead -- whole_document must be
    # False, since each branch call is NOT the entire document.
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_two_branch_doc(), fake)
    assert all(call["whole_document"] is False for call in fake.calls)


def test_build_survey_tree_passes_a_per_branch_topic_count_on_the_multi_branch_path(monkeypatch) -> None:
    # Regression guard for a confirmed real cause of run-to-run SURVEY
    # node-count variance: the multi-branch loop previously passed no
    # topic_count at all (unlike the whole-doc path), so the multi-branch
    # path had no countable node-granularity floor and relied purely on
    # the model's own open-ended judgment (see
    # orchestrator_llm_client._branch_topic_hint's docstring). Each of
    # _two_branch_doc()'s two branches has exactly one HEADING block.
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_two_branch_doc(), fake)
    assert len(fake.calls) == 2
    assert all(call["topic_count"] == 1 for call in fake.calls)


def test_build_survey_tree_passes_whole_document_true_on_the_agentic_path_too(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(area_path, query_text, embed_client, vector_store, **_):
        return None, []

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(
        _small_doc(), fake, user_id="user-descriptor-1", embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"), model="qwen3:4b",
    )
    assert len(fake.agentic_calls) == 1
    assert fake.agentic_calls[0]["whole_document"] is True
    assert fake.agentic_calls[0]["topic_count"] == 0  # _small_doc() has no headings


def test_read_document_fn_appends_a_truncation_marker_when_the_document_was_capped(monkeypatch, tmp_path) -> None:
    # Regression: KbVectorStore.get_document now returns (text, truncated)
    # instead of a bare str -- read_document_fn's closure must surface a
    # truncation marker to the model rather than silently handing back a
    # partial document as if it were complete.
    import app.kb.kb_vector_store as kb_vector_store_module
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(kb_vector_store_module, "_GET_PAGE_SIZE", 3)
    monkeypatch.setattr(kb_vector_store_module, "_MAX_DOCUMENT_CHUNKS", 2)
    monkeypatch.setattr("app.leveling.llm_leveling._KB_GET_DOCUMENT_MAX_CHUNKS", 2)

    def _fake_retrieve_context(area_path, query_text, embed_client, vector_store, **_):
        return None, []

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    for i in range(4):  # more than the patched cap (2)
        vector_store.upsert_chunk(
            chunk_id=f"source-1:big.docx:{i}", embedding=[float(i), 0.0, 0.0],
            text=f"chunk {i}", user_id="user-descriptor-1", source_file="big.docx",
            source_id="source-1", chunk_index=i, file_hash="hash-1",
        )

    fake = FakeSectionAnalysisClient()
    build_survey_tree(
        _small_doc(), fake, user_id="user-descriptor-1", embed_client=object(),
        vector_store=vector_store, model="qwen3:4b",
    )
    read_document_fn = fake.agentic_calls[0]["read_document_fn"]
    result = read_document_fn("big.docx")
    assert result.startswith("chunk 0\n\nchunk 1")
    assert "document truncated" in result


def test_node_with_empty_text_is_skipped() -> None:
    # A node with no text at all (e.g. a heading-only artifact the model
    # emitted defensively) is skipped rather than turned into an empty
    # description -- there is no per-block raw-text fallback in the holistic
    # design (that only existed in the old one-node-per-block contract).
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "text": "", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "text": "Something real.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 1
    assert tree.nodes[0].local_id == "n1"


def test_survey_tree_can_jointly_produce_every_requirement_tag_in_the_taxonomy() -> None:
    # CR6 of the corrected work plan: the original request's full taxonomy
    # (functional, non-functional, interface, performance, regulation,
    # security, safety, operation, maintenance, features,
    # behavioral/process) has 11 members (RequirementTag). No prior test
    # asserted all 11 can flow through build_survey_tree jointly.
    all_tags = list(RequirementTag)
    path = "taxonomy_survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="taxonomyhash"),
        blocks=[
            Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=f"informal note {i}", source_ref=_sr(path))
            for i in range(len(all_tags))
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[
            {
                "temp_id": str(i),
                "type": "Requirement",
                "parent_temp_id": None,
                "text": f"The system shall satisfy note {i}.",
                "tags": [tag.value],
            }
            for i, tag in enumerate(all_tags)
        ]
    )
    tree = build_survey_tree(doc, fake)
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


def test_build_survey_tree_chunks_a_multi_branch_document_into_one_call_per_branch(monkeypatch) -> None:
    # Regression: analyze_section previously always sent the ENTIRE document
    # in one call regardless of size, risking context-window overflow on a
    # large/deep document.
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_two_branch_doc(), fake)
    assert len(fake.calls) == 2  # one analyze_section call per branch, not one for the whole doc
    assert "Display" in fake.calls[0]["section_text"]
    # §3.3: the doesn't-fit path prepends a compact outline listing every
    # section's NAME (intentional -- that's the whole point of shared global
    # context) -- but branch 1's own DETAIL must not leak branch 2's detail.
    assert "5.1 surround" not in fake.calls[0]["section_text"]
    assert "5.1 surround" in fake.calls[1]["section_text"]


def test_build_survey_tree_places_a_table_into_its_own_branchs_section_text(monkeypatch) -> None:
    # §12 fix: a table is no longer silently dropped on the multi-branch
    # path -- _partition_tables_by_branch (reused from BASELINE's
    # tree_builder) buckets it into the branch it actually falls within by
    # real document-order offset, and that branch's own call now receives
    # it via `tables=`. The table's own SourceRef offset (20) sits inside
    # branch 2 ("Audio", starting at offset 15+), not branch 1.
    _force_multi_branch(monkeypatch)
    doc = _two_branch_doc()
    doc = doc.model_copy(
        update={
            "tables": [
                Table(
                    id="t0", rows=[["a", "b"]],
                    source_ref=SourceRef(document_path=doc.document.path, start_offset=20, end_offset=30),
                )
            ]
        }
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    assert not any("table(s)" in w for w in tree.warnings)
    assert "| a | b |" in fake.calls[1]["section_text"]
    assert "| a | b |" not in fake.calls[0]["section_text"]


def test_build_survey_tree_already_carries_figure_captions_via_inline_blocks_on_multi_branch_path(monkeypatch) -> None:
    # Figures never needed a placement fix here: every loader already emits
    # a figure's caption as an ordinary inline FIGURE-kind Block (see
    # render_section's docstring), so _split_into_branches carries it into
    # whichever branch it belongs to like any other block -- no separate
    # `figures=` plumbing is needed on the multi-branch path.
    _force_multi_branch(monkeypatch)
    path = "two_branch_survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio", source_ref=_sr(path)),
            Block(
                id="b3", kind=BlockKind.FIGURE, text="[FIGURE: a speaker wiring diagram]", source_ref=_sr(path),
            ),
        ],
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    assert not any("figure(s)" in w for w in tree.warnings)
    assert "speaker wiring diagram" in fake.calls[1]["section_text"]
    assert "speaker wiring diagram" not in fake.calls[0]["section_text"]


def test_build_survey_tree_does_not_warn_when_multi_branch_doc_has_no_tables_or_figures(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(_two_branch_doc(), fake)
    assert not any("table(s)" in w or "figure(s)" in w for w in tree.warnings)


def test_build_survey_tree_warns_when_a_non_empty_branch_produces_zero_nodes(monkeypatch) -> None:
    # Regression guard: a branch with real block content that the model (or
    # a tool-calling failure) turned into 0 nodes used to be completely
    # silent -- the item just never appeared in the proposed tree, with no
    # indication anything went wrong. Confirmed real gap, distinct from the
    # dropped_blocks coverage check (which assumes at least SOME nodes
    # exist to compare source blocks against).
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient(nodes=[])
    tree = build_survey_tree(_two_branch_doc(), fake)
    zero_node_warnings = [w for w in tree.warnings if "produced 0 work items" in w]
    assert len(zero_node_warnings) == 2  # both branches returned zero nodes
    assert "br0" in zero_node_warnings[0]
    assert "br1" in zero_node_warnings[1]


def test_build_survey_tree_does_not_warn_about_zero_nodes_when_a_branch_genuinely_has_none(monkeypatch) -> None:
    # A branch with NO real content (no blocks/tables/figures at all) isn't
    # a failure -- nothing to warn about.
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(_two_branch_doc(), fake)
    assert not any("produced 0 work items" in w for w in tree.warnings)


def test_build_survey_tree_does_not_warn_about_tables_on_the_single_branch_path() -> None:
    # Single-branch path DOES place tables/figures correctly (passed
    # directly to _build_survey_tree_for_branch) -- no warning expected.
    path = "table_only.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        tables=[Table(id="t0", rows=[["a", "b"]], source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "t", "text": "x", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert not any("table(s)" in w for w in tree.warnings)


def test_build_survey_tree_namespaces_node_ids_per_branch_to_avoid_collisions(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(_two_branch_doc(), fake)

    assert len(tree.nodes) == 4
    local_ids = {node.local_id for node in tree.nodes}
    # Both branches' analyze_section responses used the same local temp_ids
    # ("n0", "n1") -- without namespacing these would collide into only 2
    # distinct nodes.
    assert local_ids == {"br0_n0", "br0_n1", "br1_n0", "br1_n1"}
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["br0_n1"].parent_local_id == "br0_n0"  # parent reference namespaced to the SAME branch
    assert by_id["br1_n1"].parent_local_id == "br1_n0"
    assert by_id["br0_n0"].parent_local_id is None
    assert by_id["br1_n0"].parent_local_id is None


def test_build_survey_tree_single_branch_document_keeps_unprefixed_node_ids() -> None:
    # A document with no heading structure at all (or exactly one top-level
    # section) has exactly ONE branch -- chunking must be invisible here,
    # producing the exact same temp_ids as returned by the model.
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    local_ids = {node.local_id for node in tree.nodes}
    assert local_ids == {"n0", "n1"}


def test_build_survey_tree_scores_a_well_grounded_generated_description_highly() -> None:
    # The default fake's generated text ("The system shall handle: <source
    # text>") is a genuine paraphrase that reuses the source's own
    # significant vocabulary -- should score well above the low-grounding
    # threshold, no warning.
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    for node in tree.nodes:
        assert node.grounding_score is not None
        assert node.grounding_score >= 0.5
    assert tree.warnings == []


def test_build_survey_tree_flags_a_generated_description_unrelated_to_its_source() -> None:
    # Regression: generated text was previously trusted verbatim with ZERO
    # comparison against its source -- the model could invent unrelated
    # content and it would flow straight through with no signal at all.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {
                "temp_id": "n0",
                "type": "Requirement",
                "parent_temp_id": None,
                "text": "The warranty period is thirty-six months from purchase.",
                "tags": [],
            }
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert any(node.grounding_score is not None and node.grounding_score < 0.2 for node in tree.nodes)
    assert any("low grounding" in w for w in tree.warnings)


def test_build_survey_tree_grounds_against_the_whole_rendered_section() -> None:
    # Grounding is measured against render_section's WHOLE output for the
    # branch, not one input block -- an inherent, accepted trade-off of
    # holistic synthesis (see _build_survey_tree_for_branch's docstring).
    doc = _small_doc()
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The system shall support HDR display.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    section_text = render_section(doc.blocks)
    assert tree.nodes[0].grounding_score == _grounding_score(tree.nodes[0].description, section_text)


class FakeScoringClient:
    """Hand-written test double for BatchedScoringClient -- proves
    build_survey_tree calls score_requirements_for_document exactly once
    per branch, only when a scoring_client is actually supplied. Unchanged
    by the §2c rewrite -- BatchedScoringClient's contract is untouched."""

    def __init__(self, results: dict[str, dict] | None = None) -> None:
        self._results = results
        self.calls: list[dict[str, str]] = []
        self.criteria_contexts: list[str | None] = []

    def score_requirements_for_document(
        self,
        descriptions_by_node_id: dict[str, str],
        criteria_context: str | None = None,
        kb_context: str | None = None,
        category_checklist: list[str] | None = None,
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
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    for node in tree.nodes:
        assert node.quality_score is None
        assert node.quality_issues == []


def test_build_survey_tree_scores_only_requirement_type_nodes_when_a_scoring_client_is_supplied() -> None:
    # _DEFAULT_NODES is one Feature (n0) + one Requirement (n1) -- EARS/
    # INCOSE/ISO quality criteria describe atomic testable "shall"
    # statements, not Epic/Feature groupings, so score_requirements_for_
    # document (this test's own FakeScoringClient) is scoped to Requirement
    # nodes only. n0 stays unscored here specifically because
    # FakeScoringClient doesn't implement score_epics_and_features_for_
    # document (Epic/Feature review is a SEPARATE, optional capability --
    # see test_build_survey_tree_scores_epic_and_feature_nodes_via_the_
    # separate_rubric below for the case where it IS implemented).
    scoring_client = FakeScoringClient()
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)

    assert len(scoring_client.calls) == 1  # one batched call, not one per node
    assert set(scoring_client.calls[0].keys()) == {"n1"}
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n0"].quality_score is None  # no score_epics_and_features_for_document on this double
    assert by_id["n1"].quality_score == 90
    assert by_id["n1"].quality_issues == []


def test_build_survey_tree_scores_epic_and_feature_nodes_via_the_separate_rubric() -> None:
    # Confirmed real feature (CMMI guidance): Epic/Feature get their OWN
    # quality review (scope coherence / decomposability), separate from
    # Requirement's EARS/INCOSE wording rubric -- via score_epics_and_
    # features_for_document, an optional capability on the scoring client
    # (duck-typed, not every scoring_client needs to implement it).
    class _FullScoringClient(FakeScoringClient):
        def __init__(self) -> None:
            super().__init__()
            self.epic_feature_calls: list[dict] = []

        def score_epics_and_features_for_document(self, nodes_by_id):
            self.epic_feature_calls.append(nodes_by_id)
            return {
                node_id: {"score": 77, "categoryScores": {"scopeCoherence": 70, "outcomeClarity": 80}}
                for node_id in nodes_by_id
            }

    scoring_client = _FullScoringClient()
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)

    assert len(scoring_client.epic_feature_calls) == 1
    assert set(scoring_client.epic_feature_calls[0].keys()) == {"n0"}  # only the Feature node
    assert scoring_client.epic_feature_calls[0]["n0"] == {"type": "Feature", "text": "The system shall handle: Display"}
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n0"].quality_score == 77
    assert by_id["n0"].quality_category_scores == {"scopeCoherence": 70, "outcomeClarity": 80}
    assert by_id["n0"].quality_issues == []  # no issues vocabulary for Epic/Feature review
    # Requirement scoring (the separate rubric) is untouched.
    assert by_id["n1"].quality_score == 90


def test_build_survey_tree_excludes_a_synthesized_bridge_feature_from_epic_feature_scoring() -> None:
    # A Feature synthesized by _repair_requirement_hierarchy to hold
    # otherwise-orphaned Requirements was never a real authorial decision --
    # scoring it against scopeCoherence/capabilityClarity would produce a
    # guaranteed-low, misleading score. It must not appear in the
    # score_epics_and_features_for_document call at all.
    class _FullScoringClient(FakeScoringClient):
        def __init__(self) -> None:
            super().__init__()
            self.epic_feature_calls: list[dict] = []

        def score_epics_and_features_for_document(self, nodes_by_id):
            self.epic_feature_calls.append(nodes_by_id)
            return {node_id: {"score": 50, "categoryScores": {}} for node_id in nodes_by_id}

    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Shall do X.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": None, "text": "Shall do Y.", "tags": []},
        ]
    )
    scoring_client = _FullScoringClient()
    tree = build_survey_tree(_small_doc(), fake, scoring_client)

    synthesized = [n for n in tree.nodes if n.type == WorkItemType.FEATURE]
    assert len(synthesized) == 1
    assert synthesized[0].local_id.endswith("synth_feature")
    # The scoring call fired for zero nodes (no real Epic/Feature exists in
    # this fixture, only the synthesized bridge, which is excluded) --
    # so score_epics_and_features_for_document is never even called.
    assert scoring_client.epic_feature_calls == []
    assert synthesized[0].quality_score is None


def test_build_survey_tree_epic_feature_scoring_is_a_noop_without_scoring_client() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n0"].quality_score is None
    assert by_id["n1"].quality_score is None


def test_build_survey_tree_epic_feature_scoring_failure_is_caught_and_warned() -> None:
    class _RaisingEpicFeatureClient(FakeScoringClient):
        def score_epics_and_features_for_document(self, nodes_by_id):
            raise ValueError("boom")

    scoring_client = _RaisingEpicFeatureClient()
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)

    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n0"].quality_score is None  # failed -- but the job itself did not fail
    assert by_id["n1"].quality_score == 90  # Requirement scoring, a separate call, is unaffected
    assert any("Epic/Feature quality scoring failed" in w for w in tree.warnings)


def test_build_survey_tree_captures_the_raw_response_when_epic_feature_scoring_fails() -> None:
    class _RaisingEpicFeatureClient(FakeScoringClient):
        def score_epics_and_features_for_document(self, nodes_by_id):
            raise ValueError("boom")

    class _FakeDebugCapture:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, str]] = []

        def capture(self, kind: str, identifier: str, raw_response: str) -> None:
            self.calls.append((kind, identifier, raw_response))

    debug_capture = _FakeDebugCapture()
    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), _RaisingEpicFeatureClient(), debug_capture=debug_capture,
    )
    assert len(debug_capture.calls) == 1
    kind, identifier, raw_response = debug_capture.calls[0]
    assert kind == "score_epics_and_features"
    assert identifier == "chunk_0"
    assert "boom" in raw_response


def test_build_survey_tree_carries_category_scores_through_to_the_node() -> None:
    # The per-dimension breakdown (see QualityCategoryScores' own docstring)
    # gives a reviewer real numbers per category instead of just an overall
    # score + closed-vocabulary issue tags.
    scoring_client = FakeScoringClient(
        results={
            "n1": {
                "score": 40,
                "issues": ["ambiguous"],
                "categoryScores": {"clarity": 20, "testability": 80, "atomicity": 90, "style": 60, "rationale": 10},
            }
        }
    )
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)

    by_id = {node.local_id: node for node in tree.nodes}
    category_scores = by_id["n1"].quality_category_scores
    assert category_scores is not None
    assert category_scores["clarity"] == 20
    assert category_scores["testability"] == 80
    assert category_scores["atomicity"] == 90
    assert category_scores["style"] == 60
    assert category_scores["rationale"] == 10


def test_build_survey_tree_discards_the_whole_category_breakdown_when_one_dimension_is_malformed() -> None:
    # All-or-nothing tolerance, same philosophy as quality_score itself: a
    # partial breakdown (e.g. clarity present, testability missing) would
    # misleadingly read as "testability wasn't judged" rather than "the
    # model's response was malformed" -- discard the whole thing instead.
    scoring_client = FakeScoringClient(
        results={
            "n1": {
                "score": 40,
                "issues": [],
                "categoryScores": {"clarity": 20, "testability": 150, "atomicity": 90, "style": 60, "rationale": 10},
            }
        }
    )
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)

    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n1"].quality_category_scores is None
    assert by_id["n1"].quality_score == 40  # score/issues parsing is independent, still succeeds


def test_build_survey_tree_leaves_category_scores_none_when_the_field_is_absent() -> None:
    # Backward-compat: a scoring_client double that doesn't return
    # categoryScores at all (e.g. an older fixture) must not crash --
    # matches FakeScoringClient's own default results shape.
    scoring_client = FakeScoringClient()
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)

    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n1"].quality_category_scores is None


def test_build_survey_tree_passes_none_criteria_context_when_no_retriever_is_supplied() -> None:
    # Backward-compat: criteria_retriever is entirely optional, same as
    # scoring_client -- omitted must be byte-identical to before this
    # capability existed (score_requirements_for_document sees
    # criteria_context=None).
    scoring_client = FakeScoringClient()
    build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)
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
        FakeSectionAnalysisClient(),
        scoring_client,
        criteria_retriever=retriever,
    )

    assert len(retriever.queries) == 1  # one retrieve() call per branch, not per node
    assert scoring_client.criteria_contexts[0] is not None
    assert CRITERIA_CORPUS[0].text in scoring_client.criteria_contexts[0]


def test_build_survey_tree_records_quality_issues_from_the_closed_vocabulary_only() -> None:
    # Both nodes must be Requirement-type: scoring is scoped to Requirement
    # nodes only (see test_..._scores_only_requirement_type_nodes...), and
    # this test's own point is the closed-vocabulary filter across two
    # scored nodes, not the type gate.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The system shall handle: Display", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []},
        ]
    )
    scoring_client = FakeScoringClient(
        results={
            "n0": {"score": 40, "issues": ["ambiguous", "not_a_real_issue"]},
            "n1": {"score": 95, "issues": []},
        }
    )
    tree = build_survey_tree(_small_doc(), fake, scoring_client)

    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n0"].quality_score == 40
    assert [i.value for i in by_id["n0"].quality_issues] == ["ambiguous"]  # unknown issue silently dropped
    assert by_id["n1"].quality_score == 95


def test_build_survey_tree_falls_back_to_none_for_a_missing_or_malformed_score_and_warns() -> None:
    # Tolerant of LLM non-compliance: a missing/malformed entry for one
    # node must not crash the batch or affect sibling nodes.
    scoring_client = FakeScoringClient(
        results={
            "n0": {"score": 150, "issues": []},  # out of 0-100 range
            # "n1" missing entirely
        }
    )
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client)

    for node in tree.nodes:
        assert node.quality_score is None
    assert any("no valid score" in w for w in tree.warnings)


def test_build_survey_tree_rejects_boolean_score_values() -> None:
    # A boolean score must be rejected even though bool is a subclass of int
    # in Python — `isinstance(True, int)` returns True, but the guard
    # explicitly checks `not isinstance(raw_score, bool)` to prevent confusion
    # between True/False (semantic booleans) and valid 0-100 integer scores.
    scoring_client = FakeScoringClient(
        results={
            "n0": {"score": True, "issues": []},
            "n1": {"score": 85, "issues": []},
        }
    )
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), scoring_client=scoring_client)
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n0"].quality_score is None  # bool is rejected despite isinstance(True, int) == True
    assert by_id["n1"].quality_score == 85


def test_build_survey_tree_calls_scoring_once_for_the_whole_document_not_once_per_branch(monkeypatch) -> None:
    # §2c: scoring moved to whole-document scope -- a multi-branch document
    # gets ONE batched scoring call over every branch's requirement nodes
    # combined (chunked only past _SCORING_CHUNK_NODE_COUNT), not one call
    # per branch as before.
    _force_multi_branch(monkeypatch)
    scoring_client = FakeScoringClient()
    build_survey_tree(_two_branch_doc(), FakeSectionAnalysisClient(), scoring_client)
    assert len(scoring_client.calls) == 1
    assert set(scoring_client.calls[0].keys()) == {"br0_n1", "br1_n1"}


def test_build_survey_tree_defaults_an_invalid_analysis_type_to_requirement() -> None:
    # Reproduces a real failure observed running SURVEY mode against a real
    # local model (gemma4:e4b): the prompt explicitly lists "one of: Epic,
    # Feature, Requirement", but the model returned "Recommendation" for one
    # node anyway. Must not crash the entire job over one hallucinated type
    # on one node.
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Recommendation", "parent_temp_id": None, "text": "Single requirement line.", "tags": []}]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 1
    assert tree.nodes[0].type == WorkItemType.REQUIREMENT
    assert any("invalid type" in w for w in tree.warnings)


def test_build_survey_tree_without_area_path_skips_retrieval_entirely() -> None:
    # No user_id/embed_client/vector_store supplied -> retrieval must not
    # even be attempted -- kb_context stays None on every analyze_section call.
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 2
    assert fake.calls[0]["kb_context"] is None


def test_build_survey_tree_threads_same_kb_context_into_analysis_and_scoring(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "injected KB text"}],
        ),
    )

    fake = FakeSectionAnalysisClient()
    scoring_client = FakeScoringClient()
    build_survey_tree(
        _small_doc(),
        fake,
        scoring_client=scoring_client,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert fake.calls[0]["kb_context"] == "injected KB text"
    assert scoring_client.criteria_contexts is not None
    assert scoring_client.calls  # scoring ran
    # Same kb_context reaches score_requirements_for_document too (passed as
    # a positional/keyword kb_context arg captured via a real client in the
    # dedicated reuse test below).


def test_build_survey_tree_calls_retrieve_context_exactly_once(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    call_count = {"n": 0}

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        call_count["n"] += 1
        return None, []

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert call_count["n"] == 1


def test_build_survey_tree_unknown_model_uses_fallback_kb_path_not_agentic(monkeypatch) -> None:
    # _resolve_caps gating: an unknown model conservatively gets
    # supports_tools=False -> the once-per-document fallback path, never
    # the agentic tool-calling path, even when KB deps are configured.
    from app.kb.kb_vector_store import KbVectorStore

    call_count = {"n": 0}

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        call_count["n"] += 1
        return "ctx", []

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    fake = FakeSectionAnalysisClient()
    build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        model="some-unknown-model",
    )
    assert call_count["n"] == 1
    assert len(fake.calls) == 1
    assert fake.agentic_calls == []


def test_build_survey_tree_tool_capable_model_uses_agentic_path_and_marks_citations_relevant(monkeypatch) -> None:
    # _resolve_caps gating: a KNOWN tool-capable model routes through
    # analyze_section_agentic with an injected retrieve_fn instead of the
    # pre-computed fallback -- and every hit it pulls is marked RELEVANT
    # outright (the model chose to pull and use it itself).
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [{"source_file": "agentic.docx", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[{"source_file": "agentic.docx", "similarity": 0.9, "text": "agentic KB text"}],
    )
    tree = build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        model="qwen3:4b",  # confirmed live tool-capable, see _MODEL_CAPS
    )
    assert len(fake.agentic_calls) == 1
    assert fake.calls == []  # the fallback analyze_section is never used on this path
    retrieve_fn = fake.agentic_calls[0]["retrieve_fn"]
    assert retrieve_fn("some query") == (
        "agentic KB text",
        [{"source_file": "agentic.docx", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}],
    )
    assert tree.kb_citations[0].source_file == "agentic.docx"
    assert tree.kb_citations[0].relevance == KbCitationRelevance.RELEVANT


def test_build_survey_tree_agentic_path_reports_real_grounding_in_section_complete(monkeypatch) -> None:
    # Regression: section_complete's kb_grounded/kb_citations_raw used to
    # check `kb_context`, which is ALWAYS None on the agentic (tool-capable
    # model) path -- so a section that genuinely grounded itself via a real
    # query_kb call during analyze_section_agentic still reported "not
    # grounded" in the narration. Must use this branch's own kb_citations
    # (built from the real query_kb hits) instead.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [{"source_file": "agentic.docx", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[{"source_file": "agentic.docx", "similarity": 0.9, "text": "agentic KB text"}],
    )
    events = []
    build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        model="qwen3:4b",  # confirmed live tool-capable, see _MODEL_CAPS
        progress_callback=lambda p: events.append(p),
    )

    completed = next(e for e in events if e.phase == "section_complete")
    assert completed.kb_grounded is True
    assert completed.kb_citations == [{"source_file": "agentic.docx", "similarity": 0.9}]


def test_build_survey_tree_agentic_path_dedupes_kb_citations_by_source_file(monkeypatch) -> None:
    # Regression guard for a confirmed real bug (user-reported, via
    # screenshot): the SAME source file appeared TWICE in the "Grounded
    # against" chip list. Root cause: a real query_kb call can legitimately
    # pull several DIFFERENT chunks from the SAME file across separate tool
    # rounds, but kb_citations (the "which files backed this" UI signal)
    # previously built one entry per HIT, not per distinct file. Must dedup
    # by source_file, keeping the highest-similarity hit.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return None, []

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[
            {"source_file": "same.pdf", "similarity": 0.33, "text": "chunk one"},
            {"source_file": "same.pdf", "similarity": 0.38, "text": "chunk two"},
            {"source_file": "other.pdf", "similarity": 0.5, "text": "chunk three"},
        ],
    )
    tree = build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        model="qwen3:4b",
    )

    citations_by_file = {c.source_file: c.similarity for c in tree.kb_citations}
    assert citations_by_file == {"same.pdf": 0.38, "other.pdf": 0.5}  # highest similarity kept for the duplicated file


def test_build_survey_tree_score_requirements_events_carry_the_real_kb_citations_not_an_empty_list(monkeypatch) -> None:
    # Confirmed real user-reported bug: score_requirements/score_requirements_done
    # previously hardcoded kb_citations_raw=[] regardless of kb_grounded, so a
    # genuinely KB-grounded scoring pass rendered "grounded with 0 KB file(s)"
    # in narration -- a contradiction (kb_grounded=True, 0 citations) that reads
    # as "not really using the KB" even though scoring's own kb_context WAS
    # built from real query_kb hits. Must carry the same real per-file
    # citation list section_complete already correctly reports.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [{"source_file": "agentic.docx", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    class _FakeScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[{"source_file": "agentic.docx", "similarity": 0.9, "text": "agentic KB text"}],
    )
    events = []
    build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        model="qwen3:4b",
        scoring_client=_FakeScoringClient(),
        progress_callback=lambda p: events.append(p),
    )

    scoring_started = next(e for e in events if e.phase == "score_requirements")
    scoring_done = next(e for e in events if e.phase == "score_requirements_done")
    assert scoring_started.kb_grounded is True
    assert scoring_started.kb_citations == [{"source_file": "agentic.docx", "similarity": 0.9}]
    assert scoring_done.kb_grounded is True
    assert scoring_done.kb_citations == [{"source_file": "agentic.docx", "similarity": 0.9}]


def test_build_survey_tree_scoring_uses_the_stored_checklist_from_the_grounding_document(tmp_path, monkeypatch) -> None:
    # Confirmed real determinism requirement (user-reported): the SAME
    # document run any number of times must yield the SAME categories --
    # this is the fix: reads the checklist extracted ONCE at KB ingestion
    # time (stored via KbVectorStore.upsert_chunk) for whichever grounding
    # document contributed this scoring pass, instead of ever letting the
    # scoring LLM derive categories live.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [{"source_file": "standard.pdf", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    vector_store.upsert_chunk(
        chunk_id="s1:standard.pdf:0", embedding=[1.0, 0.0, 0.0], text="checklist text", user_id="Project\\Area1",
        source_file="standard.pdf", source_id="s1", chunk_index=0, file_hash="h1",
        quality_checklist=["Necessary", "Unambiguous", "Verifiable"],
    )

    captured: dict = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            captured["category_checklist"] = category_checklist
            return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[{"source_file": "standard.pdf", "similarity": 0.9, "text": "checklist text"}],
    )
    build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=vector_store,
        model="qwen3:4b",
        scoring_client=_CapturingScoringClient(),
    )

    assert captured["category_checklist"] == ["Necessary", "Unambiguous", "Verifiable"]


def test_build_survey_tree_falls_back_to_none_checklist_when_grounding_document_never_had_one_extracted(tmp_path, monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [{"source_file": "old_doc.pdf", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    # Ingested WITHOUT a checklist_client -- pre-dates this capability.
    vector_store.upsert_chunk(
        chunk_id="s1:old_doc.pdf:0", embedding=[1.0, 0.0, 0.0], text="some text", user_id="Project\\Area1",
        source_file="old_doc.pdf", source_id="s1", chunk_index=0, file_hash="h1",
    )

    captured: dict = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            captured["category_checklist"] = category_checklist
            return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[{"source_file": "old_doc.pdf", "similarity": 0.9, "text": "agentic KB text"}],
    )
    build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=vector_store,
        model="qwen3:4b",
        scoring_client=_CapturingScoringClient(),
    )

    assert captured["category_checklist"] is None


def test_build_survey_tree_scoring_is_actually_grounded_on_the_agentic_path() -> None:
    # Regression: scoring's kb_context always came from the OUTER kb_context
    # parameter, which is None on the agentic (tool-capable model) path --
    # only the fallback path ever populates it upfront. So scoring ran
    # completely ungrounded even when the model successfully pulled real KB
    # content via query_kb during analysis. The agentic path's own raw_hits
    # already carry each hit's full retrieved text (see
    # _execute_agentic_tool_call's citations.extend(hits)) -- must be
    # assembled into a real kb_context string and threaded to scoring.
    from app.kb.kb_vector_store import KbVectorStore

    class _FakeScoringClient:
        def __init__(self):
            self.received_kb_context = "unset"

        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            self.received_kb_context = kb_context
            return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[
            {"source_file": "a.docx", "similarity": 0.9, "text": "Real retrieved KB text about displays."},
        ],
    )
    scoring_client = _FakeScoringClient()

    build_survey_tree(
        _small_doc(),
        fake,
        scoring_client=scoring_client,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        model="qwen3:4b",
    )

    assert scoring_client.received_kb_context == "Real retrieved KB text about displays."


def test_resolve_caps_known_tool_capable_model() -> None:
    from app.leveling.llm_leveling import _resolve_caps

    caps = _resolve_caps("qwen3:4b")
    assert caps.supports_tools is True


def test_resolve_caps_gemma4_12b_is_tool_capable() -> None:
    # Regression: gemma4:12b (the orchestrator's actual configured
    # LLM_CHAT_MODEL default) was missing from _MODEL_CAPS entirely --
    # confirmed live via Ollama's /api/show that it supports tools/vision
    # just like gemma4:e4b, but any job leaving the wizard's model field on
    # "Default" silently fell through to the unknown-model, no-tools path.
    from app.leveling.llm_leveling import _resolve_caps

    caps = _resolve_caps("gemma4:12b")
    assert caps.supports_tools is True


def test_resolve_caps_qwen2_5_32b_instruct_uses_the_empirically_tested_coverage_budget() -> None:
    # Regression/documentation: confirmed live against the real 682-block
    # AirPro ICD that this model's dropped-block rate roughly HALVES at
    # coverage_budget_tokens=20_000 vs the shared local-model default of
    # 10_000 (45% -> 23%), with MORE nodes produced (not fewer) and faster
    # overall wall time -- a genuinely tested value, not an assumption from
    # this model's larger parameter count or context window alone.
    from app.leveling.llm_leveling import _resolve_caps

    caps = _resolve_caps("qwen2.5:32b-instruct")
    assert caps.supports_tools is True
    assert caps.coverage_budget_tokens == 20_000
    assert caps.context_budget_tokens == 32_000


def test_resolve_caps_qwen3_6_35b_uses_the_empirically_tested_coverage_budget() -> None:
    # Regression/documentation: confirmed live against the same real
    # 682-block AirPro ICD (with `think: False` -- see
    # orchestrator_llm_client.py's analyze_section doc comment) that this
    # MoE model dominates qwen2.5:32b-instruct outright: ~4x faster, more
    # nodes, roughly a quarter the drop rate. coverage_budget_tokens=20_000
    # was marginally better than 10_000 on every metric for this model too.
    from app.leveling.llm_leveling import _resolve_caps

    caps = _resolve_caps("qwen3.6:35b")
    assert caps.supports_tools is True
    assert caps.coverage_budget_tokens == 20_000
    assert caps.context_budget_tokens == 32_000


def test_resolve_caps_unknown_model_defaults_to_no_tools() -> None:
    from app.leveling.llm_leveling import _resolve_caps

    caps = _resolve_caps("some-random-model")
    assert caps.supports_tools is False
    assert caps.branch_cap > 0


def test_resolve_caps_frontier_prefix_gets_large_cap_and_tools() -> None:
    from app.leveling.llm_leveling import _resolve_caps

    caps = _resolve_caps("gpt-5-turbo")
    assert caps.supports_tools is True
    assert caps.branch_cap == 100_000


def test_merge_branches_by_budget_merges_adjacent_small_branches_that_fit_together() -> None:
    # §4: many small branches (one per heading, as _split_into_branches
    # produces for a document with no depth-1 headings -- the AirPro
    # pathology) should collapse into far fewer branches when their
    # combined rendered text stays under budget.
    from app.leveling.llm_leveling import _merge_branches_by_budget

    path = "survey_input.txt"
    branches = [
        [Block(id=f"b{i}", kind=BlockKind.HEADING, heading_level=1, text=f"Section {i}", source_ref=_sr(path))]
        for i in range(5)
    ]
    merged = _merge_branches_by_budget(branches, budget_tokens=1_000_000)
    assert len(merged) == 1
    assert merged[0] == [block for branch in branches for block in branch]


def test_merge_branches_by_budget_keeps_branches_separate_when_over_budget() -> None:
    # A budget too small for even two branches together must never merge
    # them -- each stays its own branch, still in document order.
    from app.leveling.llm_leveling import _merge_branches_by_budget

    path = "survey_input.txt"
    branches = [
        [Block(id=f"b{i}", kind=BlockKind.HEADING, heading_level=1, text=f"Section {i}", source_ref=_sr(path))]
        for i in range(3)
    ]
    merged = _merge_branches_by_budget(branches, budget_tokens=0)
    assert merged == branches


def test_merge_branches_by_budget_merges_only_up_to_budget_then_starts_a_new_branch() -> None:
    # Partial merge: enough budget for the first two branches together but
    # not a third -- the third starts a fresh branch rather than being
    # dropped or forced in.
    from app.leveling.llm_leveling import _estimate_tokens, _merge_branches_by_budget

    path = "survey_input.txt"
    branches = [
        [Block(id=f"b{i}", kind=BlockKind.HEADING, heading_level=1, text=f"Section {i}", source_ref=_sr(path))]
        for i in range(3)
    ]
    single_branch_tokens = _estimate_tokens(render_section(branches[0], None, None))
    merged = _merge_branches_by_budget(branches, budget_tokens=single_branch_tokens * 2)
    assert len(merged) == 2
    assert merged[0] == branches[0] + branches[1]
    assert merged[1] == branches[2]


def test_merge_branches_by_budget_handles_an_empty_branch_list() -> None:
    from app.leveling.llm_leveling import _merge_branches_by_budget

    assert _merge_branches_by_budget([], budget_tokens=1_000) == []


def test_build_survey_tree_end_to_end_injects_real_ingested_kb_chunk() -> None:
    # Integration test: exercises the real retrieve_context + real
    # KbVectorStore (no monkeypatching), proving the full chain --
    # build_survey_tree -> retrieve_context -> KbVectorStore.query -> back
    # into analyze_section's kb_context -- actually delivers a
    # previously-ingested chunk's text, not just that each seam's contract
    # is honored in isolation.
    from app.kb.kb_vector_store import KbVectorStore

    store = KbVectorStore(persist_path="/tmp/unused-in-this-test-real-kb")
    store.upsert_chunk(
        chunk_id="source-1:spec.docx:0",
        embedding=[1.0, 0.0, 0.0],
        text="The receiver shall decode HDR10 metadata.",
        user_id="Project\\Area1",
        source_file="spec.docx",
        source_id="source-1",
        chunk_index=0,
        file_hash="hash-1",
    )

    class _FakeEmbedClient:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[1.0, 0.0, 0.0]]

    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=_FakeEmbedClient(),
        vector_store=store,
    )

    assert fake.calls[0]["kb_context"] == "The receiver shall decode HDR10 metadata."
    assert [c.source_file for c in tree.kb_citations] == ["spec.docx"]


def test_build_survey_tree_reuses_same_kb_context_for_scoring_as_other_calls(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    captured: dict[str, str | None] = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(
            self,
            descriptions_by_node_id: dict[str, str],
            criteria_context: str | None = None,
            kb_context: str | None = None,
            category_checklist: list[str] | None = None,
        ) -> dict[str, dict]:
            captured["scoring_kb_context"] = kb_context
            return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "injected KB text"}],
        ),
    )

    build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        scoring_client=_CapturingScoringClient(),
    )
    assert captured["scoring_kb_context"] == "injected KB text"


def test_build_survey_tree_without_area_path_has_empty_kb_citations() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert tree.kb_citations == []


def test_build_survey_tree_threads_kb_citations_from_retrieve_context(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [
                {"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"},
                {"source_file": "doc-b.pdf", "distance": 0.2, "similarity": 0.8, "text": "chunk b"},
            ],
        ),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert [c.source_file for c in tree.kb_citations] == ["doc-a.docx", "doc-b.pdf"]


def test_build_survey_tree_kb_citations_empty_when_retrieval_finds_nothing(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (None, []),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations == []


def test_build_survey_tree_kb_citations_stay_unknown_relevance_when_no_relevance_client(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"}],
        ),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations[0].relevance == KbCitationRelevance.UNKNOWN


def test_build_survey_tree_kb_citations_get_verified_relevance_when_relevance_client_supplied(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
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
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
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
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"}],
        ),
    )

    class _RaisingKbRelevanceClient:
        def judge_kb_relevance(self, branch_content: str, snippets: list[dict]) -> dict[str, str]:
            raise RuntimeError("orchestrator unreachable")

    tree = build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        kb_relevance_client=_RaisingKbRelevanceClient(),
    )
    assert tree.kb_citations[0].relevance == KbCitationRelevance.UNKNOWN


class FakeTraceLinkInferenceClient:
    """Hand-written test double for infer_trace_links — proves build_survey_tree
    calls it exactly once per document (whole-tree, not per-node), and that
    the discovered catalog is passed through unchanged. Unaffected by the
    §2c rewrite -- infer_trace_links is untouched."""

    def __init__(self, results: list[dict] | None = None) -> None:
        self._results = results if results is not None else []
        self.calls: list[dict] = []

    def infer_trace_links(self, nodes: list[dict], link_type_catalog: list[dict], kb_context: str | None = None) -> list[dict]:
        self.calls.append({"nodes": nodes, "link_type_catalog": link_type_catalog, "kb_context": kb_context})
        return self._results


def test_build_survey_tree_without_link_type_client_leaves_trace_links_empty() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert tree.trace_links == []


def test_build_survey_tree_sends_trace_link_nodes_without_a_redundant_title_key() -> None:
    # title duplicated description's content for no signal (the model
    # references node_id, not title, in its output) -- dropped to save
    # tokens. text must NOT be truncated (a separate, deliberate
    # non-change) since external ref ids can appear anywhere in it.
    fake_client = FakeTraceLinkInferenceClient()
    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=[],
    )
    assert len(fake_client.calls) == 1
    for node in fake_client.calls[0]["nodes"]:
        assert set(node.keys()) == {"node_id", "type", "text"}


def test_build_survey_tree_calls_infer_trace_links_exactly_once_with_the_catalog() -> None:
    fake_client = FakeTraceLinkInferenceClient()
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}]
    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(fake_client.calls) == 1
    assert fake_client.calls[0]["link_type_catalog"] == catalog


def test_build_survey_tree_degrades_to_empty_trace_links_when_inference_raises() -> None:
    # Confirmed real job failure: infer_trace_links serializes every node in
    # the whole document into one prompt (the largest single payload in this
    # module) and a model occasionally ignores the "no prose" instruction,
    # producing a non-JSON reply that raises ValueError. This is purely an
    # enrichment pass over already-completed analysis/scoring work -- same
    # "must never fail a SURVEY job" fail-open philosophy already applied to
    # KB retrieval/relevance verification -- so it must degrade to
    # trace_links=[] with a warning, not abort the whole job and discard
    # everything already produced.
    class _RaisingTraceLinkClient:
        def infer_trace_links(self, nodes, link_type_catalog, kb_context=None):
            raise ValueError("malformed JSON in LLM response content: 'Based'")

    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=_RaisingTraceLinkClient(), link_type_catalog=[],
    )
    assert tree.trace_links == []
    assert len(tree.nodes) == 2  # analysis output is unaffected
    assert any("Trace/coverage link inference failed" in w for w in tree.warnings)


def test_build_survey_tree_captures_the_raw_response_when_trace_link_inference_fails() -> None:
    class _RaisingTraceLinkClient:
        def infer_trace_links(self, nodes, link_type_catalog, kb_context=None):
            raise ValueError("malformed JSON in LLM response content: 'Based'")

    class _FakeDebugCapture:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, str]] = []

        def capture(self, kind: str, identifier: str, raw_response: str) -> None:
            self.calls.append((kind, identifier, raw_response))

    debug_capture = _FakeDebugCapture()
    build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=_RaisingTraceLinkClient(), link_type_catalog=[],
        debug_capture=debug_capture,
    )
    assert len(debug_capture.calls) == 1
    kind, identifier, raw_response = debug_capture.calls[0]
    assert kind == "infer_trace_links"
    assert identifier == "document"
    assert "malformed JSON in LLM response content: 'Based'" in raw_response


def test_build_survey_tree_resolves_intra_job_link_target() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "n1", "target_ref": "n0", "reference_name": "System.LinkTypes.Related"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=[],
    )
    assert len(tree.trace_links) == 1
    link = tree.trace_links[0]
    assert link.source_local_id == "n1"
    assert link.target_kind == "intraJob"
    assert link.target_local_id == "n0"
    assert link.resolution_status == "pending"


def test_build_survey_tree_treats_a_non_node_id_target_ref_as_cross_job_customer_id() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "n1", "target_ref": "REQ-SYS-012", "reference_name": "Elisra.CoveredBy-Reverse"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=[],
    )
    link = tree.trace_links[0]
    assert link.target_kind == "crossJob"
    assert link.target_customer_id == "REQ-SYS-012"
    assert link.target_local_id is None


def test_build_survey_tree_drops_a_link_with_a_reference_name_not_in_the_catalog() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[
            {"source_node_id": "n1", "target_ref": "n0", "reference_name": "Hallucinated.NotReal"},
            {"source_node_id": "n1", "target_ref": "n0", "reference_name": "System.LinkTypes.Related"},
        ]
    )
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}]
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(tree.trace_links) == 1
    assert tree.trace_links[0].reference_name == "System.LinkTypes.Related"


def test_build_survey_tree_drops_a_link_whose_source_node_id_does_not_exist() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "does-not-exist", "target_ref": "n0", "reference_name": "System.LinkTypes.Related"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=[{"reference_name": "System.LinkTypes.Related", "name": "Related"}],
    )
    assert tree.trace_links == []


def test_build_survey_tree_bounds_an_oversized_top_level_branch_into_multiple_analysis_calls(monkeypatch) -> None:
    # Reproduces a real failure: a document can have very few top-level
    # sections (here, deliberately just one) that are themselves still too
    # large for a single per-branch analyze_section call. build_survey_tree
    # must bound branch size directly (_bound_branch_size), not rely solely
    # on the document's own heading structure -- proven here by lowering the
    # bound low enough that this modest synthetic doc still must be split
    # into more than one analyze_section call.
    import app.leveling.llm_leveling as llm_leveling_module

    monkeypatch.setattr(llm_leveling_module, "_MAX_SURVEY_BRANCH_BLOCK_COUNT", 3)
    _force_multi_branch(monkeypatch)  # this tiny doc otherwise fits §3's whole-doc gate

    path = "one_big_section.txt"
    blocks = [Block(id="b0", kind=BlockKind.PARAGRAPH, text="2 Title", source_ref=_sr(path))]
    for i in range(1, 7):
        blocks.append(Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=f"2.{i} The system shall do thing {i}.", source_ref=_sr(path)))
    doc = CanonicalDoc(document=Document(path=path, format=DocumentFormat.TXT, sha256="h"), blocks=blocks)

    class _CountingSectionAnalysisClient:
        def __init__(self) -> None:
            self.call_count = 0

        def analyze_section(
            self, section_text: str, kb_context: str | None = None, whole_document: bool = False,
            topic_count: int | None = None,
        ) -> tuple[list[dict], bool]:
            self.call_count += 1
            # §3.3: doesn't-fit branches get the compact document outline
            # prepended, separated by "---" -- only count lines from this
            # branch's OWN section text, not the shared outline's lines.
            own_text = section_text.rsplit("\n\n---\n\n", 1)[-1]
            lines = [line for line in own_text.strip().split("\n") if line]
            return [
                {"temp_id": str(i), "type": "Requirement", "parent_temp_id": None, "title": line[:80], "text": line, "tags": []}
                for i, line in enumerate(lines)
            ], False

        def analyze_section_agentic(self, section_text: str, retrieve_fn, **kwargs) -> tuple[list[dict], list[dict], bool]:
            raise AssertionError("model default is not tool-capable -- agentic path must not be used")

    fake = _CountingSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)

    # Without bounding, this single-top-level-branch document would produce
    # exactly ONE analyze_section call for all 7 blocks.
    assert fake.call_count > 1
    # Every source block must still end up represented somewhere in the
    # tree -- bounding must never silently drop content.
    assert len(tree.nodes) == 7


def test_build_survey_tree_progress_callback_carries_the_sections_heading_as_its_label(monkeypatch) -> None:
    # Without this, the UI could only ever show an anonymous "Section N of
    # M" -- no way to tell WHICH real content a job was analyzing when it
    # failed. _two_branch_doc's branches each start with their own HEADING
    # block ("Display" / "Audio") -- the common case _split_into_branches
    # produces.
    _force_multi_branch(monkeypatch)
    events = []
    build_survey_tree(_two_branch_doc(), FakeSectionAnalysisClient(), progress_callback=lambda p: events.append(p))
    # Each branch now fires two events (analyze_section, then section_complete
    # once its nodes are finalized) -- filter to the phase that starts each
    # branch to keep this test about section labeling, not event count.
    analyze_events = [e for e in events if e.phase == "analyze_section"]
    assert analyze_events[0].section_label == "Display"
    assert analyze_events[1].section_label == "Audio"


def test_build_survey_tree_progress_callback_falls_back_to_an_excerpt_when_the_section_has_no_heading() -> None:
    tree_doc = _small_doc()  # two plain PARAGRAPH blocks, no HEADING
    events = []
    build_survey_tree(tree_doc, FakeSectionAnalysisClient(), progress_callback=lambda p: events.append(p))
    assert events[0].section_label == "Display"  # first block's own text


def test_build_survey_tree_progress_callback_falls_back_to_a_tables_caption_for_a_blocks_empty_branch() -> None:
    path = "sheet.xlsx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[Table(id="t0", rows=[["a", "b"]], caption="Sheet1", source_ref=_sr(path))],
    )
    events = []
    build_survey_tree(doc, FakeSectionAnalysisClient(), progress_callback=lambda p: events.append(p))
    assert events[0].section_label == "Sheet1"


def test_build_survey_tree_fires_progress_callback_for_each_real_step_boundary() -> None:
    events = []

    tree = build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        progress_callback=lambda p: events.append(p),
    )

    phases = [e.phase for e in events]
    assert phases == ["analyze_section", "section_complete"]
    assert all(e.branch_index == 0 for e in events)
    assert all(e.branch_count == 1 for e in events)
    assert all(e.kb_grounded is False for e in events)


def test_build_survey_tree_progress_callback_fires_score_requirements_when_scoring_client_present() -> None:
    events = []

    class _FakeScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}

    build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        scoring_client=_FakeScoringClient(),
        progress_callback=lambda p: events.append(p),
    )

    # §2c: scoring is a whole-document pass that runs AFTER every branch's
    # own section_complete (scoring is no longer per-branch/inline).
    assert [e.phase for e in events] == [
        "analyze_section",
        "section_complete",
        "score_requirements",
        "score_requirements_done",
    ]


def test_build_survey_tree_progress_callback_carries_the_sections_finished_nodes() -> None:
    # The real "parsed and formatted response" for a section -- lets a
    # reviewer inspect what THIS section actually produced live, without
    # waiting for the whole job to reach diff_ready.
    events = []

    class _FakeScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            return {node_id: {"score": 87, "issues": ["vague_term"]} for node_id in descriptions_by_node_id}

    build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        scoring_client=_FakeScoringClient(),
        progress_callback=lambda p: events.append(p),
    )

    completed = next(e for e in events if e.phase == "section_complete")
    assert completed.section_nodes is not None
    assert len(completed.section_nodes) == 2
    requirement_node = next(n for n in completed.section_nodes if n["type"] == "Requirement")
    assert requirement_node["title"]
    assert requirement_node["text"]
    # §2c: scoring is now a whole-document pass that runs AFTER every
    # branch's section_complete fires -- quality_score is always None at
    # section_complete time; the frontend patches it in once
    # score_requirements_done arrives for this node.
    assert requirement_node["quality_score"] is None
    feature_node = next(n for n in completed.section_nodes if n["type"] == "Feature")
    assert feature_node["quality_score"] is None


def test_build_survey_tree_progress_callback_carries_model_draft_count_and_issues_found() -> None:
    # FakeSectionAnalysisClient (the usual double) has no `.model` attribute
    # at all -- confirms the real getattr(client, 'model', None) lookup in
    # _build_survey_tree_for_branch's _fire is truly optional, not a
    # required Protocol member every test double must implement.
    class _AnalysisClientWithModel(FakeSectionAnalysisClient):
        model = "qwen2.5:32b"

    class _FakeScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            # One node scored with two issues, the rest clean -- exercises a
            # real non-zero issues_found sum, not just a trivial 0 case.
            first_id = next(iter(descriptions_by_node_id))
            return {
                node_id: (
                    {"score": 60, "issues": ["vague_term", "compound"]}
                    if node_id == first_id
                    else {"score": 95, "issues": []}
                )
                for node_id in descriptions_by_node_id
            }

    events = []
    build_survey_tree(
        _small_doc(),
        _AnalysisClientWithModel(),
        scoring_client=_FakeScoringClient(),
        progress_callback=lambda p: events.append(p),
    )

    by_phase = {e.phase: e for e in events}
    assert all(e.model == "qwen2.5:32b" for e in events)
    # _DEFAULT_NODES is one Feature + one Requirement -- draft_count reflects
    # only the Requirement-type nodes actually sent for scoring (see
    # test_..._scores_only_requirement_type_nodes...), not every node the
    # section produced.
    requirement_count = sum(1 for n in _DEFAULT_NODES if n["type"] == "Requirement")
    assert by_phase["score_requirements"].draft_count == requirement_count
    assert by_phase["score_requirements_done"].issues_found == 2


def test_render_section_interleaves_a_table_at_its_real_document_position() -> None:
    # §12: sample.docx has a table BETWEEN two paragraphs ("...picture
    # presets." / table / "See the diagram below..."). Before the loader
    # body-walk + render_section rewrite, the table's SourceRef was a (0,0)
    # placeholder and render_section always appended it at the section's
    # very end under a "### Tables" marker, regardless of its real position.
    from pathlib import Path

    from app.loaders.docx_loader import load_docx

    doc = load_docx(str(Path(__file__).parent / "fixtures" / "sample.docx"))
    section_text = render_section(doc.blocks, doc.tables, doc.figures)

    before_idx = section_text.index("three picture presets")
    table_idx = section_text.index("| Mode | Description |")
    after_idx = section_text.index("See the diagram below")
    assert before_idx < table_idx < after_idx


def test_render_section_interleaves_a_pdf_table_at_its_real_position_and_dedupes_its_text() -> None:
    # §12/§13: sample.pdf has "Backplane Power Budget" / prose / a
    # Rail-Voltage table -- proves the table lands after the prose (not
    # appended at the section's end) AND that the table's own cell text
    # ("Rail", "3.3V") does NOT ALSO leak into a duplicate paragraph block
    # (the pdf dedup bug: page.extract_text() previously re-captured table
    # cell text extract_tables() already got).
    from pathlib import Path

    from app.loaders.pdf_loader import load_pdf

    doc = load_pdf(str(Path(__file__).parent / "fixtures" / "sample.pdf"))
    section_text = render_section(doc.blocks, doc.tables, doc.figures)

    before_idx = section_text.index("Backplane Power Budget")
    table_idx = section_text.index("| Rail | Voltage | Max Current |")
    assert before_idx < table_idx
    # The paragraph text must not ALSO contain the table's own cell values.
    paragraph_lines = [line for line in section_text.split("\n") if not line.startswith("|")]
    assert not any("3.3V" in line for line in paragraph_lines)


def test_build_survey_tree_warns_on_a_referenced_attachment_it_did_not_ingest() -> None:
    # §14 Tier 1: a cheap, always-on regex scan flags a section that
    # references an external artifact (a numbered ReqID here) this SURVEY
    # run never itself ingested -- a reviewable signal to add it to the KB,
    # not an attempt to resolve/fetch it (that's Tier 2, deferred).
    path = "referenced.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="See ReqID 12345 for the full connector pinout.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "See ReqID 12345 for the full connector pinout.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert any("ReqID 12345" in w and "did not ingest" in w for w in tree.warnings)


def test_build_survey_tree_does_not_warn_on_a_section_with_no_attachment_references() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert not any("did not ingest" in w for w in tree.warnings)


def test_build_survey_tree_warns_on_an_unfilled_reqid_placeholder() -> None:
    # §10.4 fix: the regex used to require actual digits (reqid\s*\d+) and
    # silently missed a real document's own unfilled authoring placeholder
    # text ("ReqID XXXX", not a filled-in number) -- widened to match
    # "reqid" alone so this genuinely-unresolvable reference is flagged.
    path = "referenced_placeholder.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="According to ReqID XXXX: EMI/EMC table.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "According to ReqID XXXX: EMI/EMC table.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    # The match itself is bare "ReqID" (no trailing digits to capture from
    # the unfilled "XXXX" placeholder) -- still enough to flag the section.
    assert any("ReqID" in w and "did not ingest" in w for w in tree.warnings)


def test_build_survey_tree_does_not_double_report_a_block_as_both_dropped_and_referenced() -> None:
    # §10.4 dedup: a block matching the external-reference pattern gets its
    # own, more actionable warning -- it must not ALSO show up in the
    # generic "did not reference N of M blocks" list for the same content.
    path = "referenced_and_dropped.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.PARAGRAPH,
                text="According to ReqID XXXX the EMI/EMC shielding values are defined externally.",
                source_ref=_sr(path),
            ),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "An unrelated requirement.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert any("did not ingest" in w for w in tree.warnings)
    assert not any("did not reference" in w for w in tree.warnings)


def test_build_survey_tree_produces_a_non_empty_tree_for_a_table_only_xlsx_doc() -> None:
    # §4: load_xlsx returns blocks=[], tables=[one per sheet] -- with no
    # headings at all, _split_into_branches yields [] (the single/zero-branch
    # path). Before this fix, that path called _build_survey_tree_for_branch
    # WITHOUT tables/figures, so render_section([]) == "" and an xlsx-only
    # upload silently produced an empty SURVEY tree.
    path = "sheet.xlsx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[
            Table(
                id="t0",
                rows=[["Req ID", "Text"], ["R1", "The unit shall power on within 5 seconds."]],
                caption="Sheet1",
                source_ref=_sr(path),
            )
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The unit shall power on within 5 seconds.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert len(tree.nodes) == 1
    assert len(fake.calls) == 1
    assert "Req ID" in fake.calls[0]["section_text"]  # the table actually reached render_section
    assert tree.nodes[0].source_ref == doc.tables[0].source_ref  # representative ref falls back to the table


def test_build_survey_tree_progress_callback_never_fires_when_omitted() -> None:
    # Regression guard: progress_callback is entirely optional -- omitting it
    # (every pre-existing caller) must not attempt to call None.
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert len(tree.nodes) == 2


# Coverage-safe chunking (§1/§2 of the AirPro under-synthesis fix): a document
# can fit comfortably inside a model's real context window while still being
# too large to safely analyze in ONE holistic call (lost-in-the-middle
# positional bias) -- these tests use REAL text sizes against gemma4:e4b's
# real caps (context 90_000 tokens, coverage 10_000 tokens), not the
# `_force_multi_branch` monkeypatch (which reports an impossibly large size
# regardless of real budget logic) -- they exercise the actual gate/merge.

_LONG_PARAGRAPH = (
    "The system shall provide a mechanism for the operator to configure, "
    "monitor, and audit every relevant parameter of this subsystem, "
    "ensuring full traceability of all state transitions. " * 40
)  # ~2_500 chars/block -- comfortably between the coverage and context budgets when repeated


def _doc_between_coverage_and_context_budget(with_headings: bool) -> CanonicalDoc:
    """~50_000 rendered chars (~12_500 est. tokens): exceeds gemma4:e4b's
    10_000-token coverage budget (with headroom, doesn't fit) but stays well
    under its 90_000-token context budget (fits context) -- the exact case
    the old context-budget-only gate got wrong."""
    path = "long_input.txt"
    blocks = []
    for i in range(20):
        if with_headings:
            blocks.append(
                Block(id=f"h{i}", kind=BlockKind.HEADING, heading_level=2, text=f"Section {i}", source_ref=_sr(path))
            )
        blocks.append(Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=_LONG_PARAGRAPH, source_ref=_sr(path)))
    return CanonicalDoc(document=Document(path=path, format=DocumentFormat.TXT, sha256="h"), blocks=blocks)


def test_document_that_fits_context_but_exceeds_coverage_budget_is_chunked() -> None:
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_doc_between_coverage_and_context_budget(with_headings=True), fake, model="gemma4:e4b")
    assert len(fake.calls) > 1
    assert all(call["whole_document"] is False for call in fake.calls)


def test_large_headingless_document_is_window_chunked() -> None:
    # No heading structure at all -- _split_into_branches has no boundary to
    # split on, so without the flat-doc window-chunk path this would still
    # take the single-call path and reproduce the under-synthesis bug on any
    # large flat/prose document, not just headed ones.
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_doc_between_coverage_and_context_budget(with_headings=False), fake, model="gemma4:e4b")
    assert len(fake.calls) > 1
    assert all(call["whole_document"] is False for call in fake.calls)


def test_small_document_stays_single_call_and_byte_identical_with_named_model() -> None:
    # Backward-compat lock: a small document must still take the single-call
    # path, unprefixed local_ids, even when a real model name is supplied
    # (not just the default model=None path already covered elsewhere).
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(_small_doc(), fake, model="gemma4:e4b")
    assert len(fake.calls) == 1
    assert fake.calls[0]["whole_document"] is True
    assert {node.local_id for node in tree.nodes} == {"n0", "n1"}


def test_build_survey_tree_reparents_a_requirement_directly_under_an_epic() -> None:
    # Confirmed real bug (user-reported): the model occasionally skips the
    # Feature level entirely, putting a Requirement straight under an Epic --
    # a real Epic->Feature->Requirement chain violation the prompt alone
    # (soft LLM instruction) doesn't always prevent.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "text": "System outcome.", "tags": []},
            {"temp_id": "n1", "type": "Feature", "parent_temp_id": "n0", "text": "A capability.", "tags": []},
            {"temp_id": "n2", "type": "Requirement", "parent_temp_id": "n0", "text": "Shall do X.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    by_id = {node.local_id: node for node in tree.nodes}
    assert len(tree.nodes) == 3  # re-parented, not synthesized -- a real Feature (n1) was available
    assert by_id["n2"].parent_local_id == "n1"
    assert any("re-parented under Feature n1" in w for w in tree.warnings)


def test_build_survey_tree_reparents_a_requirement_chained_under_another_requirement() -> None:
    # Requirement -> Requirement -> Feature: the repair must walk UP the
    # chain to find the real Feature ancestor, not just check the immediate
    # parent's type and give up.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "text": "A capability.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "text": "Shall do X.", "tags": []},
            {"temp_id": "n2", "type": "Requirement", "parent_temp_id": "n1", "text": "Shall do Y.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n2"].parent_local_id == "n0"
    assert any("re-parented under Feature n0" in w for w in tree.warnings)


def test_build_survey_tree_synthesizes_a_feature_when_no_real_feature_exists_at_all() -> None:
    # Confirmed real bug (user-reported): two "standalone" Requirements with
    # no Feature or Epic anywhere in the branch -- there is nothing real to
    # re-parent under, so a grouping Feature must be synthesized rather than
    # leaving them orphaned roots.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Shall do X.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": None, "text": "Shall do Y.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 3  # 2 requirements + 1 synthesized Feature
    by_id = {node.local_id: node for node in tree.nodes}
    synthesized = [n for n in tree.nodes if n.type == WorkItemType.FEATURE]
    assert len(synthesized) == 1
    # Both requirements land under the SAME synthesized Feature, not one each.
    assert by_id["n0"].parent_local_id == synthesized[0].local_id
    assert by_id["n1"].parent_local_id == synthesized[0].local_id
    assert any("inserted a synthesized grouping Feature" in w for w in tree.warnings)


def test_build_survey_tree_does_not_touch_an_already_valid_hierarchy() -> None:
    # No-op guard: a correctly-shaped Epic -> Feature -> Requirement tree
    # must not be modified or warned about at all.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "text": "System outcome.", "tags": []},
            {"temp_id": "n1", "type": "Feature", "parent_temp_id": "n0", "text": "A capability.", "tags": []},
            {"temp_id": "n2", "type": "Requirement", "parent_temp_id": "n1", "text": "Shall do X.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 3
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n2"].parent_local_id == "n1"
    assert not any("re-parented" in w or "synthesized" in w for w in tree.warnings)


def test_build_survey_tree_does_not_touch_a_genuinely_sole_root_requirement() -> None:
    # Regression guard for the O(n^2) hoist in _repair_requirement_hierarchy
    # (root_count/has_epic_or_feature precomputed once instead of rescanned
    # per violation): a single standalone Requirement with no Feature/Epic
    # anywhere is legitimate (a section that's just one atomic requirement)
    # and must NOT be forced under a synthesized bridge Feature.
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Shall do X.", "tags": []}]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 1
    assert tree.nodes[0].parent_local_id is None
    assert not any("re-parented" in w or "synthesized" in w for w in tree.warnings)


def test_build_survey_tree_synthesizes_one_feature_shared_by_three_root_requirements() -> None:
    # Regression guard for the same hoist: with 3+ originally-root
    # Requirements and no real Feature anywhere, every one of them must
    # still land under the SAME synthesized bridge, including the LAST one
    # processed (by which point the earlier two have already been
    # re-parented and are no longer "null parent" nodes themselves) --
    # proving has_epic_or_feature's in-place update after synthesis keeps
    # working even after the precomputed root_count itself has gone stale.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Shall do X.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": None, "text": "Shall do Y.", "tags": []},
            {"temp_id": "n2", "type": "Requirement", "parent_temp_id": None, "text": "Shall do Z.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    assert len(tree.nodes) == 4  # 3 requirements + 1 synthesized Feature
    by_id = {node.local_id: node for node in tree.nodes}
    synthesized = [n for n in tree.nodes if n.type == WorkItemType.FEATURE]
    assert len(synthesized) == 1
    assert by_id["n0"].parent_local_id == synthesized[0].local_id
    assert by_id["n1"].parent_local_id == synthesized[0].local_id
    assert by_id["n2"].parent_local_id == synthesized[0].local_id
