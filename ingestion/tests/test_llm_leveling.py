import time

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, Figure, SourceRef, Table, TableCell, plain_text_rows
from app.leveling.llm_leveling import (
    SectionAnalysisClient,
    _derive_section_label,
    _detect_conflicting_duplicates,
    _ensure_root_features_have_epic_parent,
    _grounding_score,
    _group_label_became_a_node,
    _regroup_disconnected_roots,
    _render_block_line,
    _repair_group_attachment,
    _unsupported_content_warnings,
    _widen_branch_page_range,
    build_survey_tree,
    render_section,
)
from app.leveling.narration_publisher import LevelingProgress
from app.leveling.table_groups import TableGroupInfo
from app.workitem.model import KbCitationRelevance
from app.workitem.model import RequirementQualityIssue, RequirementTag, WarningKind, WorkItemMode, WorkItemNode, WorkItemType


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _node(
    local_id: str, node_type: WorkItemType, parent_local_id: str | None, title: str,
) -> WorkItemNode:
    """Minimal WorkItemNode builder for unit-testing the repair/matching
    functions directly, bypassing build_survey_tree -- used where the
    table-driven deterministic path (id_hierarchy/id_tree_builder) now
    claims any table that would otherwise reach these functions via the
    LLM path, making an end-to-end table fixture unable to exercise them
    any more (see each converted test's own docstring)."""
    ref = _sr("x.docx")
    return WorkItemNode(
        local_id=local_id, type=node_type, parent_local_id=parent_local_id, title=title,
        description=title, source_ref=ref, mode=WorkItemMode.SURVEY,
    )


def _req_node(local_id: str, description: str) -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id, type=WorkItemType.REQUIREMENT, parent_local_id=None,
        title=description[:60], description=description, source_ref=_sr("x.docx"),
        mode=WorkItemMode.SURVEY,
    )


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

# Two SIBLING leaves under a common root -- for trace-link tests that need
# two node ids NOT in a direct parent/child relationship (see
# _infer_trace_links_for_nodes's parent/child redundancy filter: a link
# between a node and its own tree-parent is dropped as redundant with the
# hierarchy already covering that pair, so a trace-link test asserting a
# link SURVIVES must not accidentally use a parent/child pair like
# _DEFAULT_NODES' n0/n1).
_SIBLING_NODES = [
    {"temp_id": "s0", "type": "Feature", "parent_temp_id": None, "title": "Root", "text": "Root feature.", "tags": []},
    {"temp_id": "s1", "type": "Requirement", "parent_temp_id": "s0", "title": "Sibling A", "text": "Requirement A.", "tags": []},
    {"temp_id": "s2", "type": "Requirement", "parent_temp_id": "s0", "title": "Sibling B", "text": "Requirement B.", "tags": []},
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
        topic_count: int | None = None, table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
    ) -> tuple[list[dict], bool]:
        self.calls.append({
            "section_text": section_text, "kb_context": kb_context,
            "whole_document": whole_document, "topic_count": topic_count,
            "table_group_hints": table_group_hints,
            "expected_root_count": expected_root_count,
        })
        return self._nodes, self._truncated

    def analyze_section_agentic(
        self, section_text: str, retrieve_fn, list_documents_fn=None, read_document_fn=None,
        read_other_section_fn=None, whole_document: bool = False, topic_count: int | None = None,
        table_group_hints: list[tuple[str, str]] | None = None,
        expected_root_count: int | None = None,
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
                "table_group_hints": table_group_hints,
                "expected_root_count": expected_root_count,
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


def test_identity_hash_is_stable_across_runs_despite_llm_wording_drift() -> None:
    # Regression (S5): identity_hash used to hash the LLM-generated `text`
    # itself, combined with representative_source_ref -- a section-wide
    # reference EVERY node from that section shares (analyze_section has no
    # per-node source attribution). Re-running the SAME section against a
    # model that phrases the SAME semantic content differently (real,
    # observed LLM behavior at temperature 0 across different runs/backends)
    # therefore never matched via the exact-hash idempotency lookup. Fixed
    # by re-keying on local_id (deterministic given the same node
    # count/order) instead of the generated text.
    nodes_run_1 = [
        {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Display", "text": "The system shall handle: Display", "tags": []},
        {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "title": "HDR", "text": "The display shall support HDR content.", "tags": []},
    ]
    nodes_run_2 = [
        {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Display", "text": "The system shall provide: Display", "tags": []},
        {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "title": "HDR", "text": "The system shall support high dynamic range on the display.", "tags": []},
    ]
    tree_1 = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(nodes=nodes_run_1))
    tree_2 = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(nodes=nodes_run_2))

    assert tree_1.nodes[0].description != tree_2.nodes[0].description  # genuinely different wording
    assert tree_1.nodes[0].identity_hash == tree_2.nodes[0].identity_hash
    assert tree_1.nodes[1].identity_hash == tree_2.nodes[1].identity_hash
    # Still distinct from each other within one run (different local_id).
    assert tree_1.nodes[0].identity_hash != tree_1.nodes[1].identity_hash


def test_regrouped_synthesized_node_identity_hash_differs_from_its_own_first_child() -> None:
    # Regression: a synthesized group/epic/feature node (root_regrouping.py)
    # deliberately reuses one of its own member's source_ref (no distinct
    # span of its own) -- since plain _hash_identity is now position-only,
    # without a discriminator the synthesized PARENT's identity_hash would
    # collide with its own first CHILD's.
    roots = [
        _node("n0", WorkItemType.FEATURE, None, "Power Sequencing"),
        _node("n1", WorkItemType.FEATURE, None, "Power Monitoring"),
    ]

    class FakeGroupingClient:
        def group_root_topics(self, titles_by_id: dict[str, str]) -> dict:
            return {"groups": [{"title": "Power", "member_ids": ["n0", "n1"]}]}

    warnings: list[str] = []
    _regroup_disconnected_roots(roots, "", FakeGroupingClient(), warnings)
    group_node = next(n for n in roots if n.local_id == "synth_group_0")
    first_child = next(n for n in roots if n.local_id == "n0")

    assert group_node.source_ref == first_child.source_ref  # deliberately shared, per design
    assert group_node.identity_hash != first_child.identity_hash


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
    assert "did not reference 4 of 5 source block(s)" in tree.warnings[0].raw
    # Regression: a bare index list forced a reviewer to go dig up the raw
    # parsed document to judge whether a dropped block was a real loss or
    # benign non-requirement content -- a text preview per block answers
    # that right in the warning itself, with no internal index/id exposed.
    assert '"The receiver shall log all firmware errors."' in tree.warnings[0].raw
    assert '"The battery shall charge fully within two hours."' in tree.warnings[0].raw


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


def test_build_survey_tree_does_not_flag_an_uncaptioned_figure_as_a_dropped_block() -> None:
    # A figure with no caption (vision judged it insignificant, OR vision
    # failed/was disabled -- both cases render identically as "[FIGURE: none]")
    # must not be flagged as a "dropped" block -- there was nothing to lose
    # either way.
    path = "empty_figure.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="The unit shall boot within ten seconds.", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "Boot time", "text": "The unit shall boot within ten seconds.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert tree.warnings == []


def test_build_survey_tree_never_lets_an_unsupported_content_note_reach_section_path() -> None:
    # End-to-end regression for the "[UNSUPPORTED: ...]" diagnostic-text leak
    # (pdf_loader.py's multi-column false-positive heuristic firing on a
    # cover page): the diagnostic NOTE block is this headingless branch's
    # very first block, which is exactly the shape that previously became
    # section_path (via _derive_section_label's blocks[0] fallback) and
    # tainted every node's Section field. It must never reach section_path,
    # and must not silently vanish -- only surface as a warning instead.
    path = "scanned.pdf"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.PDF, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.NOTE,
                text="[UNSUPPORTED: page 1 appears multi-column; extraction may misorder text]",
                source_ref=_sr(path),
            ),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)

    assert len(tree.nodes) > 0
    for node in tree.nodes:
        assert not any("[UNSUPPORTED:" in part for part in node.source_ref.section_path)
    assert any(w.kind == WarningKind.UNSUPPORTED_CONTENT_NOTE for w in tree.warnings)
    # The diagnostic must not ALSO surface as a generic DROPPED_BLOCKS entry
    # -- it already has its own, more specific warning.
    assert not any(w.kind == WarningKind.DROPPED_BLOCKS for w in tree.warnings)


def test_build_survey_tree_never_lets_a_degraded_table_note_leak_as_content() -> None:
    # Task 6 end-to-end pin: pdf_loader.py's table-structural-failure NOTE
    # (emitted when `_build_pdf_table_grid`'s structural walk throws --
    # test_load_pdf_table_structural_failure_emits_unsupported_note in
    # test_pdf_loader.py) must go through the exact same Task 1 machinery as
    # the multi-column NOTE above: surface as an UNSUPPORTED_CONTENT_NOTE
    # warning, never as fake section/description content.
    path = "sample.pdf"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.PDF, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.NOTE,
                text="[UNSUPPORTED: table extraction degraded structure (span/gap information lost) for a table on page 1]",
                source_ref=_sr(path),
            ),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Power Budget", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="The board shall draw no more than 3.3V.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)

    assert len(tree.nodes) > 0
    for node in tree.nodes:
        assert not any("[UNSUPPORTED:" in part for part in node.source_ref.section_path)
        assert "[UNSUPPORTED:" not in node.description
    assert any(w.kind == WarningKind.UNSUPPORTED_CONTENT_NOTE for w in tree.warnings)


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
    assert any(
        '"Orphan requirement."' in w.raw and "attached as a root of this section instead" in w.raw
        for w in tree.warnings
    )
    assert any('re-parented under Feature "Root requirement."' in w.raw for w in tree.warnings)


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
    assert any("had no model title" in w.raw for w in tree.warnings)


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


def test_build_document_outline_lists_every_heading_in_a_merged_branch(monkeypatch) -> None:
    # Regression: _build_document_outline previously called
    # _derive_section_label, which returns only a branch's FIRST heading --
    # a branch merged from multiple original sections (the common case)
    # lost every heading after the first.
    #
    # A second top-level heading ("Audio") is required so
    # _split_into_branches itself produces >=2 real branches -- with only
    # one top-level heading (as an earlier version of this fixture had),
    # build_survey_tree takes the single-branch windowing fallback (§4),
    # which re-chunks per-block under _force_multi_branch's blanket
    # huge-token mock and always yields one block per branch -- "Display"
    # and "Picture Modes" would then never actually land in the SAME
    # branch, and this test would not exercise a genuinely merged branch
    # at all (see test_topic_count_counts_numbered_pseudo_headings_on_the_
    # multi_branch_path's own comment for the same root cause).
    _force_multi_branch(monkeypatch)
    path = "outline_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=2, text="Picture Modes", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="Three presets are supported.", source_ref=_sr(path)),
            Block(id="b4", kind=BlockKind.HEADING, heading_level=1, text="Audio", source_ref=_sr(path)),
            Block(id="b5", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    # Branch 1 ("Display" + "Picture Modes", genuinely merged under one
    # top-level heading) is analyzed first; branch 2 ("Audio") second.
    # Assert against branch 2's OWN call: its own raw section text never
    # mentions "Display" or "Picture Modes" at all, so the only way either
    # string can appear in its section_text is via the shared outline
    # (global_context) that _build_document_outline built from BOTH
    # branches -- this proves the outline itself lists every heading from
    # the merged first branch, not just coincidental raw-block-text
    # presence in a branch's own call (which calls[0] alone could not
    # distinguish, since branch 1's own rendered text trivially contains
    # both heading strings regardless of the outline).
    outline_bearing_section_text = fake.calls[1]["section_text"]
    assert "Display" in outline_bearing_section_text
    assert "Picture Modes" in outline_bearing_section_text


def test_build_document_outline_lists_a_numbered_pseudo_heading(monkeypatch) -> None:
    # Regression: a plain-paragraph numbered heading ("3.2 Backplane
    # Power", no HEADING-kind block at all) was invisible to the outline
    # even though resolve_block_depth (what _split_into_branches itself
    # uses) already treats it as a real heading boundary.
    _force_multi_branch(monkeypatch)
    path = "numbered_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="2 Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert "1 Display" in fake.calls[0]["section_text"]
    assert "2 Audio" in fake.calls[1]["section_text"]


def test_topic_count_counts_numbered_pseudo_headings_on_the_whole_document_path() -> None:
    # Same undercount bug, second site: heading_count (line ~1458) used
    # BlockKind.HEADING directly, undercounting a numbered-paragraph spec's
    # real section count on the whole-document (fits-in-one-call) path.
    path = "numbered_whole_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="2 Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["whole_document"] is True
    assert fake.calls[0]["topic_count"] == 2


def test_topic_count_counts_numbered_pseudo_headings_on_the_multi_branch_path(monkeypatch) -> None:
    # Same undercount bug, per-branch site (line ~1691).
    # A trailing second top-level heading ("2 Audio") is required so
    # _split_into_branches itself produces >=2 real branches -- with only
    # one top-level heading, build_survey_tree takes the single-branch
    # windowing fallback (§4), which re-chunks per-block under
    # _force_multi_branch's blanket huge-token mock and always yields one
    # block per branch, defeating this test's actual point (two
    # heading-equivalent blocks landing in the SAME branch).
    _force_multi_branch(monkeypatch)
    path = "numbered_multi_branch.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="1.1 Resolution", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="2 Audio", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["topic_count"] == 2  # "1 Display" AND "1.1 Resolution", not just 0


def test_build_document_outline_shows_a_synthesized_number_label_when_present(monkeypatch) -> None:
    # Component 2 (docx_loader Task 9) populates Block.number_label for a
    # heading with no number of its own -- the outline must render it
    # ("3.2 Backplane Power") so a cross-referencing branch can actually
    # use the number a human would recognize, not just the bare title.
    _force_multi_branch(monkeypatch)
    path = "labeled_doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display",
                  number_label="1", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio",
                  number_label="2", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert "1 Display" in fake.calls[0]["section_text"]


def _force_multi_branch_with_real_token_sizes(monkeypatch) -> None:
    """Same GOAL as _force_multi_branch (force the doesn't-fit-in-one-call
    multi-branch path, and stop _merge_branches_by_budget from re-combining
    the resulting branches) but via the coverage-BUDGET lever instead of
    blanket-mocking _estimate_tokens to a constant. The glossary-inlining
    tests below need _estimate_tokens to report each branch's REAL rendered
    size, because _find_glossary_sections evaluates a candidate glossary
    branch's actual size against _GLOSSARY_INLINE_MAX_TOKENS -- blanket-
    mocking _estimate_tokens (as _force_multi_branch does) makes EVERY
    branch, including a genuinely tiny glossary section, report as
    oversized, collapsing the inline-vs-exclude distinction these tests
    exist to verify. Forcing coverage_budget_tokens down to an
    unsatisfiable 1 achieves the same "doesn't fit, never re-merge"
    behavior as _force_multi_branch's blanket mock, without touching
    _estimate_tokens at all."""
    import app.leveling.llm_leveling as llm_leveling_module
    from app.leveling.model_caps import _ModelCaps

    monkeypatch.setattr(
        llm_leveling_module, "_resolve_caps",
        lambda model, caps_client=None: _ModelCaps(1000, 28_000, 1, False),
    )


def _doc_with_glossary_branch(path: str = "glossary_doc.txt") -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Definitions and Acronyms",
                  source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="HDR: High Dynamic Range.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )


def test_a_small_glossary_branch_is_inlined_into_a_different_branchs_context(monkeypatch) -> None:
    _force_multi_branch_with_real_token_sizes(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_doc_with_glossary_branch(), fake)
    assert len(fake.calls) == 2
    # The Display branch's OWN call receives the glossary branch's content.
    display_call = next(c for c in fake.calls if "The display shall support HDR." in c["section_text"])
    assert "HDR: High Dynamic Range." in display_call["section_text"]


def test_a_branch_does_not_get_its_own_content_re_inlined(monkeypatch) -> None:
    _force_multi_branch_with_real_token_sizes(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_doc_with_glossary_branch(), fake)
    glossary_call = next(c for c in fake.calls if "Definitions and Acronyms" in c["section_text"])
    # "HDR: High Dynamic Range." appears once (in section_text itself, as
    # the glossary branch's OWN content) -- not a second time via a
    # self-referential inlined copy.
    assert glossary_call["section_text"].count("HDR: High Dynamic Range.") == 1


def test_an_oversized_glossary_branch_is_not_inlined(monkeypatch) -> None:
    _force_multi_branch_with_real_token_sizes(monkeypatch)
    path = "oversized_glossary.txt"
    huge_definition = "Term: " + ("word " * 2000)  # well over the inline token cap
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Glossary", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text=huge_definition, source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    display_call = next(c for c in fake.calls if "The display shall support HDR." in c["section_text"])
    assert huge_definition not in display_call["section_text"]
    assert "Glossary" in display_call["section_text"]  # still shows up as an outline label


def test_a_branch_with_no_glossary_heading_match_gets_no_extra_context(monkeypatch) -> None:
    _force_multi_branch_with_real_token_sizes(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_two_branch_doc(), fake)  # "Display"/"Audio" -- no glossary-keyword heading
    assert len(fake.calls) == 2
    for call in fake.calls:
        assert "Reference section" not in call["section_text"]


# ---------------------------------------------------------------------------
# Front-matter heading guard -- deterministic, zero-LLM-cost content filter
# ---------------------------------------------------------------------------


def test_front_matter_heading_pattern_matches_typical_boilerplate_headings() -> None:
    from app.leveling.llm_leveling import _FRONT_MATTER_HEADING_PATTERN

    assert _FRONT_MATTER_HEADING_PATTERN.search("1 Introduction")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Table of Contents")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Revision History")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Document History")
    assert _FRONT_MATTER_HEADING_PATTERN.search("Appendix A")
    assert _FRONT_MATTER_HEADING_PATTERN.search("2.3 References")


def test_front_matter_heading_pattern_does_not_match_real_content_headings() -> None:
    from app.leveling.llm_leveling import _FRONT_MATTER_HEADING_PATTERN

    assert not _FRONT_MATTER_HEADING_PATTERN.search("3 Interface Requirements")
    assert not _FRONT_MATTER_HEADING_PATTERN.search("System Overview")
    assert not _FRONT_MATTER_HEADING_PATTERN.search("4.1 Power Interface")


def test_find_front_matter_branches_returns_indices_of_matching_branches() -> None:
    from app.leveling.llm_leveling import _find_front_matter_branches

    path = "doc.txt"
    intro_heading = Block(id="b0", kind=BlockKind.HEADING, text="Introduction", number_label="1", heading_level=1, source_ref=_sr(path))
    intro_body = Block(id="b1", kind=BlockKind.PARAGRAPH, text="This document describes...", source_ref=_sr(path))
    real_heading = Block(id="b2", kind=BlockKind.HEADING, text="Interface Requirements", number_label="2", heading_level=1, source_ref=_sr(path))
    real_body = Block(id="b3", kind=BlockKind.PARAGRAPH, text="The unit shall...", source_ref=_sr(path))
    branches = [[intro_heading, intro_body], [real_heading, real_body]]

    assert _find_front_matter_branches(branches) == {0}


def test_combine_global_context_appends_front_matter_guard_only_for_matched_branch_index() -> None:
    from app.leveling.llm_leveling import _combine_global_context, _FRONT_MATTER_GUARD_TEXT

    matched = _combine_global_context("outline", 0, [], None, front_matter_branch_indices={0})
    assert _FRONT_MATTER_GUARD_TEXT in matched

    unmatched = _combine_global_context("outline", 1, [], None, front_matter_branch_indices={0})
    assert _FRONT_MATTER_GUARD_TEXT not in unmatched
    assert unmatched == "outline"


def test_combine_global_context_omits_front_matter_guard_when_indices_not_supplied() -> None:
    # Byte-identical to pre-Task-1 behavior when the new param is omitted --
    # every pre-existing call site that doesn't yet pass it is unaffected.
    from app.leveling.llm_leveling import _combine_global_context

    result = _combine_global_context("outline", 0, [])
    assert result == "outline"


def test_build_survey_tree_front_matter_branch_still_allows_a_real_requirement_to_surface(monkeypatch) -> None:
    # The guard is a soft instruction, not a hard skip -- if the model still
    # emits a real node for content inside a front-matter-labeled section
    # (e.g. a genuine requirement accidentally placed under "Introduction"),
    # that node must still reach the tree.
    _force_multi_branch_with_real_token_sizes(monkeypatch)
    path = "doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, text="Introduction", number_label="1", heading_level=1, source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The unit shall boot within ten seconds.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, text="System Overview", number_label="2", heading_level=1, source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="This system provides power management.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "title": "Boot time", "text": "The unit shall boot within ten seconds.", "tags": []}]
    )
    tree = build_survey_tree(doc, fake)
    assert len(tree.nodes) >= 1
    assert any("Boot time" in n.title for n in tree.nodes)


def test_front_matter_guard_for_whole_document_names_matching_headings_and_is_none_without_any() -> None:
    from app.leveling.llm_leveling import _front_matter_guard_for_whole_document

    path = "doc.txt"
    blocks = [
        Block(id="b0", kind=BlockKind.HEADING, text="Introduction", number_label="1", heading_level=1, source_ref=_sr(path)),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="This document describes...", source_ref=_sr(path)),
        Block(id="b2", kind=BlockKind.HEADING, text="Interface Requirements", number_label="2", heading_level=1, source_ref=_sr(path)),
    ]
    guard = _front_matter_guard_for_whole_document(blocks)
    assert guard is not None
    assert "1 Introduction" in guard
    assert "Interface Requirements" not in guard

    no_front_matter = [b for b in blocks if b.id != "b0"]
    assert _front_matter_guard_for_whole_document(no_front_matter) is None


def test_front_matter_guard_for_whole_document_text_does_not_trip_the_external_reference_warning() -> None:
    # The guard string is prepended to section_text, which
    # _referenced_attachment_warnings scans -- if the guard's own prose named
    # "appendix"/"annex"/"attached" as examples, every guarded document would
    # gain a spurious EXTERNAL_REFERENCE warning manufactured out of the
    # instruction text itself. Pins the deliberate wording choice.
    from app.leveling.llm_leveling import _REFERENCED_ATTACHMENT_PATTERN, _front_matter_guard_for_whole_document

    path = "doc.txt"
    guard = _front_matter_guard_for_whole_document(
        [Block(id="b0", kind=BlockKind.HEADING, text="Introduction", heading_level=1, source_ref=_sr(path))]
    )
    assert guard is not None
    assert not _REFERENCED_ATTACHMENT_PATTERN.search(guard)


# --- [UNSUPPORTED: ...] diagnostic-note leak fix (pdf_loader.py's
# multi-column false-positive note must never leak as real content -- see
# _is_unsupported_content_note in tree_builder.py) ---


def test_derive_section_label_skips_an_unsupported_content_note_block() -> None:
    path = "doc.txt"
    blocks = [
        Block(id="b0", kind=BlockKind.NOTE, text="[UNSUPPORTED: page 3 appears multi-column]", source_ref=_sr(path)),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
    ]
    label = _derive_section_label(blocks, tables=None, figures=None)
    assert label == "The display shall support HDR."


def test_derive_section_label_does_not_skip_a_note_block_without_the_unsupported_prefix() -> None:
    # Pins prefix-based (not BlockKind.NOTE-based) filtering: pptx_loader.py
    # legitimately uses NOTE for real speaker-notes content, which must NOT
    # be treated the same as a loader diagnostic placeholder.
    path = "deck.pptx"
    blocks = [
        Block(id="b0", kind=BlockKind.NOTE, text="Remember to emphasize the roadmap slide.", source_ref=_sr(path)),
    ]
    label = _derive_section_label(blocks, tables=None, figures=None)
    assert label == "Remember to emphasize the roadmap slide."


def test_render_block_line_omits_an_unsupported_content_note_block() -> None:
    path = "doc.txt"
    block = Block(id="b0", kind=BlockKind.NOTE, text="[UNSUPPORTED: page 7 appears multi-column]", source_ref=_sr(path))
    assert _render_block_line(block) is None


def test_render_block_line_does_not_omit_a_note_block_without_the_unsupported_prefix() -> None:
    path = "deck.pptx"
    block = Block(id="b0", kind=BlockKind.NOTE, text="Speaker note: mention Q3 roadmap.", source_ref=_sr(path))
    assert _render_block_line(block) == "Speaker note: mention Q3 roadmap."


def test_unsupported_content_warnings_emits_one_warning_per_distinct_diagnostic_note() -> None:
    path = "doc.txt"
    blocks = [
        Block(id="b0", kind=BlockKind.NOTE, text="[UNSUPPORTED: page 3 appears multi-column]", source_ref=_sr(path)),
        Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        # Same diagnostic text repeated -- must be deduped, not double-warned.
        Block(id="b2", kind=BlockKind.NOTE, text="[UNSUPPORTED: page 3 appears multi-column]", source_ref=_sr(path)),
        Block(id="b3", kind=BlockKind.NOTE, text="[UNSUPPORTED: page 9 appears multi-column]", source_ref=_sr(path)),
    ]
    warnings = _unsupported_content_warnings(blocks, section_label="Display")
    assert len(warnings) == 2
    assert all(w.kind == WarningKind.UNSUPPORTED_CONTENT_NOTE for w in warnings)
    assert {w.detail["text"] for w in warnings} == {
        "[UNSUPPORTED: page 3 appears multi-column]",
        "[UNSUPPORTED: page 9 appears multi-column]",
    }


def test_unsupported_content_warnings_is_empty_without_any_matching_note() -> None:
    path = "doc.txt"
    blocks = [Block(id="b0", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path))]
    assert _unsupported_content_warnings(blocks, section_label="Display") == []


def test_build_survey_tree_applies_the_front_matter_guard_on_the_single_call_path() -> None:
    # A document short enough to fit in ONE call (the most common real input)
    # previously got no front-matter guard at all -- it was only wired into
    # the multi-branch loop's per-branch global_context.
    path = "doc.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, text="Introduction", number_label="1", heading_level=1, source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="This document describes the display unit.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, text="Display Requirements", number_label="2", heading_level=1, source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)

    assert len(fake.calls) == 1  # genuinely the single-call path, not a multi-branch run
    assert fake.calls[0]["whole_document"] is True  # the guard must NOT flip this flag
    assert "typical front-matter" in fake.calls[0]["section_text"]
    assert "1 Introduction" in fake.calls[0]["section_text"]
    # Advisory only -- the model's nodes still reach the tree unchanged.
    assert len(tree.nodes) >= 1


def test_build_survey_tree_single_call_section_text_is_unchanged_without_front_matter() -> None:
    # Byte-identical to pre-fix behavior for a document with no front-matter
    # heading: no guard string, nothing prepended.
    doc = _small_doc()
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)

    assert "typical front-matter" not in fake.calls[0]["section_text"]
    assert not fake.calls[0]["section_text"].startswith("Some heading")


def _table_with_group(rows: list[list[str]], path: str = "survey_input.txt", offset: int = 0) -> Table:
    return Table(
        id="t0", cells=[[TableCell(text=c) for c in row] for row in rows],
        source_ref=SourceRef(document_path=path, start_offset=offset, end_offset=offset + 10),
    )


def test_build_survey_tree_builds_a_qualifying_table_deterministically() -> None:
    # Superseded by the deterministic table-driven builder
    # (id_hierarchy.rows_from_table / _detect_deterministic_subtrees): a
    # table whose rows qualify as a real ID hierarchy (2+ children, no
    # "shall" on the group row) is now built directly from the table's
    # own structure -- it is claimed entirely before the LLM path ever
    # sees it, so table_group_hints/topic_count's table-floor contribution
    # (the OLD hint-based mechanism this test used to pin) no longer fires
    # for a table that fully qualifies; see
    # test_build_survey_tree_ignores_a_non_conforming_table_for_topic_count
    # for the still-live non-qualifying-table case.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "External Source Detection"],
                    ["1.1.1", "The system shall detect X."],
                    ["1.1.2", "The system shall detect Y."],
                ])
            ]
        }
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    # table_group_hints/topic_count's table contribution no longer fires --
    # llm_doc.tables is empty by the time the LLM path runs.
    assert fake.calls[0]["topic_count"] == 0
    assert fake.calls[0]["table_group_hints"] is None
    group_node = next(n for n in tree.nodes if n.title == "External Source Detection")
    assert group_node.type == WorkItemType.FEATURE
    children = [n for n in tree.nodes if n.parent_local_id == group_node.local_id]
    assert {n.title for n in children} == {"The system shall detect X.", "The system shall detect Y."}


def test_build_survey_tree_fires_deterministic_subtree_progress_for_a_qualifying_table() -> None:
    # Real gap this closes: _detect_deterministic_subtrees ran immediately
    # after preparing_analysis with zero narration of its own -- confirmed
    # live as a genuine 20+ minute silent window on a document with many
    # ID-hierarchy table rows.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "External Source Detection"],
                    ["1.1.1", "The system shall detect X."],
                    ["1.1.2", "The system shall detect Y."],
                ])
            ]
        }
    )
    events: list = []
    build_survey_tree(doc, FakeSectionAnalysisClient(), progress_callback=lambda p: events.append(p))

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 1
    assert subtree_events[0].subtree_index == 0
    assert subtree_events[0].subtree_count == 1
    assert subtree_events[0].subtree_label == "Table t0"


def test_build_survey_tree_fires_deterministic_subtree_progress_for_a_structural_heading_document() -> None:
    events: list = []
    build_survey_tree(
        _structural_heading_doc(), FakeSectionAnalysisClient(), progress_callback=lambda p: events.append(p)
    )

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 1
    assert subtree_events[0].subtree_index == 0
    assert subtree_events[0].subtree_count == 1
    assert subtree_events[0].subtree_label == "Heading hierarchy"


def test_build_survey_tree_reports_the_real_subtree_count_across_multiple_qualifying_subtrees() -> None:
    # One qualifying table AND a structural-heading residual -- both
    # subtrees must be counted in subtree_count from the very first event,
    # not just however many have been seen so far.
    doc = _structural_heading_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "External Source Detection"],
                    ["1.1.1", "The system shall detect X."],
                    ["1.1.2", "The system shall detect Y."],
                ])
            ]
        }
    )
    events: list = []
    build_survey_tree(doc, FakeSectionAnalysisClient(), progress_callback=lambda p: events.append(p))

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 2
    assert [e.subtree_count for e in subtree_events] == [2, 2]
    assert [e.subtree_index for e in subtree_events] == [0, 1]
    assert subtree_events[0].subtree_label == "Table t0"
    assert subtree_events[1].subtree_label == "Heading hierarchy"


def test_build_survey_tree_does_not_count_a_one_child_group_toward_topic_count() -> None:
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "External Source Detection"],
                    ["1.1.1", "The system shall detect X."],
                ])
            ]
        }
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["topic_count"] == 0  # zero headings, no qualifying group -- unchanged
    assert fake.calls[0]["table_group_hints"] is None


def test_build_survey_tree_ignores_a_non_conforming_table_for_topic_count() -> None:
    # Matches the existing throwaway 2-cell-non-ID table fixture already
    # used elsewhere in this file -- confirms zero regression for every
    # other test that attaches a trivial, non-conforming table.
    doc = _small_doc().model_copy(update={"tables": [_table_with_group([["a", "b"]])]})
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["topic_count"] == 0
    assert fake.calls[0]["table_group_hints"] is None


def test_build_survey_tree_scopes_table_group_floor_per_branch(monkeypatch) -> None:
    # A single Table's rows are never split across branches (whole tables
    # are bucketed by source_ref, see _partition_tables_by_branch) -- the
    # correct multi-branch fixture is two SEPARATE tables, each landing in
    # a different branch, each with its own qualifying group. Real,
    # DISTINCT per-block offsets are required here (unlike _two_branch_doc,
    # whose blocks all share the same dummy _sr() offset and so can't
    # actually distinguish branch boundaries for table partitioning).
    _force_multi_branch(monkeypatch)
    path = "two_branch_survey_input.txt"

    def sr(start: int, end: int) -> SourceRef:
        return SourceRef(document_path=path, start_offset=start, end_offset=end)

    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=sr(0, 5)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=sr(5, 15)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio", source_ref=sr(100, 105)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=sr(105, 115)),
        ],
        tables=[
            _table_with_group(
                [
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "Display Group"],
                    ["1.1.1", "The system shall do A."],
                    ["1.1.2", "The system shall do B."],
                ],
                path=path, offset=10,  # inside branch 1's range (0-15), before branch 2 starts at 100
            ),
            _table_with_group(
                [
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "Audio Group"],
                    ["1.1.1", "The system shall do C."],
                    ["1.1.2", "The system shall do D."],
                ],
                path=path, offset=110,  # inside branch 2's range (100-115)
            ),
        ],
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    assert len(fake.calls) == 2
    # Both tables now fully qualify for the deterministic table-driven
    # builder (id_hierarchy.rows_from_table) and are claimed before either
    # branch's LLM call -- table_group_hints/the table's own topic_count
    # contribution no longer fire; each branch's own heading is the only
    # remaining contribution.
    assert fake.calls[0]["table_group_hints"] is None
    assert fake.calls[1]["table_group_hints"] is None
    assert fake.calls[0]["topic_count"] == 1
    assert fake.calls[1]["topic_count"] == 1
    assert {n.title for n in tree.nodes if n.type == WorkItemType.FEATURE} >= {"Display Group", "Audio Group"}


def test_build_survey_tree_derives_expected_root_count_from_top_level_groups() -> None:
    # Superseded by the deterministic table-driven builder for a table
    # that fully qualifies: "Television Receiver"/"Remote Control" are now
    # built as 2 real, independent deterministic root nodes directly (not
    # steered toward via an LLM prompt hint) -- expected_root_count's own
    # table contribution no longer fires since the table is claimed before
    # the LLM path runs at all.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1", "Television Receiver"],
                    ["1.1", "The system shall do A."],
                    ["1.2", "The system shall do B."],
                    ["2", "Remote Control"],
                    ["2.1", "The system shall do C."],
                    ["2.2", "The system shall do D."],
                ])
            ]
        }
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    assert fake.calls[0]["expected_root_count"] is None
    det_roots = [
        n for n in tree.nodes
        if n.parent_local_id is None and n.title in ("Television Receiver", "Remote Control")
    ]
    assert len(det_roots) == 2


def test_build_survey_tree_leaves_expected_root_count_none_with_a_single_top_level_group() -> None:
    # Fewer than 2 independent top-level groups -- today's default
    # single-root prompt wording must stay in effect (None, not 1).
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1", "Television Receiver"],
                    ["1.1", "The system shall do A."],
                    ["1.2", "The system shall do B."],
                ])
            ]
        }
    )
    fake = FakeSectionAnalysisClient()
    build_survey_tree(doc, fake)
    assert fake.calls[0]["expected_root_count"] is None


def test_build_survey_tree_builds_the_group_deterministically_regardless_of_llm_output() -> None:
    # Superseded by the deterministic table-driven builder: a qualifying
    # table's group node is now built directly from the table's own
    # structure, independent of whatever the LLM returns for the
    # document's residual (non-table) content -- the old "coverage
    # warning" CATCH mechanism (steer via prompt hint, warn if steering
    # failed) is no longer needed for a table that fully qualifies, since
    # there's no LLM steering involved in producing it at all.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "External Source Detection"],
                    ["1.1.1", "The system shall detect X."],
                    ["1.1.2", "The system shall detect Y."],
                ])
            ]
        }
    )
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Unrelated Feature", "text": "Shall do X.", "tags": []},
        ]
    )
    tree = build_survey_tree(doc, fake)
    assert any(n.title == "External Source Detection" for n in tree.nodes)
    assert not any("did not produce a distinctly-titled node" in w.raw for w in tree.warnings)


def test_build_survey_tree_does_not_warn_when_a_qualifying_group_did_become_a_node() -> None:
    # Positive control: the coverage check must NOT fire just because a
    # table group exists -- only when no node's title reflects it.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "External Source Detection"],
                    ["1.1.1", "The system shall detect X."],
                    ["1.1.2", "The system shall detect Y."],
                ])
            ]
        }
    )
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "External Source Detection", "text": "Shall do X.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "title": "Detect X", "text": "Shall detect X.", "tags": []},
            {"temp_id": "n2", "type": "Requirement", "parent_temp_id": "n0", "title": "Detect Y", "text": "Shall detect Y.", "tags": []},
        ]
    )
    tree = build_survey_tree(doc, fake)
    assert not any("did not produce a distinctly-titled node" in w.raw for w in tree.warnings)


def test_repair_group_attachment_resolves_the_correct_parent_despite_common_word_ambiguity() -> None:
    # Confirmed live against the real TV-receiver/remote-control document:
    # a short, common-word label like "Audio Control" fractional-overlap
    # matched 6 different unrelated node titles (any title containing
    # EITHER "audio" or "control" alone was enough under the old
    # threshold-based check), which silently defeated the repair entirely
    # -- it correctly refused to guess among 6 candidates, so it never
    # fired for exactly the case it exists to fix. Full-word-containment +
    # fewest-extra-words tie-break must resolve this to the one node
    # containing BOTH words with the least noise ("Audio Control Settings"),
    # not treat it as ambiguous.
    #
    # Tested directly against _repair_group_attachment rather than via
    # build_survey_tree: a table this fully-qualifying is now claimed
    # entirely by the deterministic table-driven builder
    # (id_hierarchy.rows_from_table) before the LLM path ever runs, so an
    # end-to-end table fixture can no longer exercise this LLM-output
    # repair function at all -- it only ever fires for a table that does
    # NOT fully qualify for the deterministic path but still has some
    # residual table_groups signal, or (unexercised here) a future
    # heading-hierarchy caller.
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "Audio Control Settings"),
        _node("n1", WorkItemType.REQUIREMENT, "n0", "Adjust Volume Level"),
        _node("n2", WorkItemType.FEATURE, None, "Remote-Control Buttons"),
        _node("n3", WorkItemType.REQUIREMENT, "n2", "Select Audio Output Device"),
        # Model attached "Mute Behavior" under the wrong Feature (n2).
        _node("n4", WorkItemType.REQUIREMENT, "n2", "Mute Behavior"),
        _node("n5", WorkItemType.REQUIREMENT, "n4", "Restore Volume on Unmute"),
        _node("n6", WorkItemType.REQUIREMENT, "n4", "Volume Change While Muted"),
    ]
    table_groups = [
        TableGroupInfo(label="Mute Behavior", child_count=2, id_text="1.2", suggested_type="Requirement", parent_label="Audio Control"),
    ]
    warnings: list[str] = []
    _repair_group_attachment(nodes, table_groups, "", warnings)
    mute_node = next(n for n in nodes if n.title == "Mute Behavior")
    audio_control_node = next(n for n in nodes if n.title == "Audio Control Settings")
    assert mute_node.parent_local_id == audio_control_node.local_id
    assert any("attached under the wrong ancestor" in w.raw for w in warnings)


def test_repair_group_attachment_repairs_a_group_attached_to_the_wrong_ancestor() -> None:
    # Confirmed live: a group can be correctly detected, typed, and split
    # into real child nodes, yet still land under the WRONG parent (e.g.
    # "Mute and Volume-Restore Behavior" under "Channel Scan" instead of
    # "Audio Control"). The table's own ID hierarchy already knows the
    # correct parent ("Audio Control") -- this repairs it deterministically
    # after generation rather than trusting the model's own placement.
    #
    # Tested directly (see the previous test's docstring for why an
    # end-to-end table fixture can no longer reach this function).
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "Audio Control"),
        _node("n1", WorkItemType.REQUIREMENT, "n0", "Adjust Volume Level"),
        _node("n2", WorkItemType.FEATURE, None, "Channel Scan"),
        _node("n3", WorkItemType.REQUIREMENT, "n2", "Scan Channels"),
        # Model attached "Mute Behavior" under Channel Scan (n2) instead
        # of its real parent Audio Control (n0) -- the bug under test.
        _node("n4", WorkItemType.REQUIREMENT, "n2", "Mute Behavior"),
        _node("n5", WorkItemType.REQUIREMENT, "n4", "Restore Volume on Unmute"),
        _node("n6", WorkItemType.REQUIREMENT, "n4", "Volume Change While Muted"),
    ]
    table_groups = [
        TableGroupInfo(label="Mute Behavior", child_count=2, id_text="1.2", suggested_type="Requirement", parent_label="Audio Control"),
    ]
    warnings: list[str] = []
    _repair_group_attachment(nodes, table_groups, "", warnings)
    mute_node = next(n for n in nodes if n.title == "Mute Behavior")
    audio_control_node = next(n for n in nodes if n.title == "Audio Control")
    assert mute_node.parent_local_id == audio_control_node.local_id
    assert any("attached under the wrong ancestor" in w.raw for w in warnings)


def test_build_survey_tree_does_not_repair_attachment_when_already_correct() -> None:
    # True no-op when the model already attached the group correctly --
    # must never fire a repair or warning just because a parent_label exists.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "Audio Control"],
                    ["1.1.1", "The system shall control volume."],
                    ["1.1.2", "Mute Behavior"],
                    ["1.1.2.a", "The system shall restore volume on unmute."],
                    ["1.1.2.b", "The system shall allow volume changes while muted."],
                ])
            ]
        }
    )
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Audio Control", "text": "Shall handle audio.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "title": "Adjust Volume Level", "text": "Shall control volume.", "tags": []},
            {"temp_id": "n4", "type": "Requirement", "parent_temp_id": "n0", "title": "Mute Behavior", "text": "General mute behavior.", "tags": []},
            {"temp_id": "n5", "type": "Requirement", "parent_temp_id": "n4", "title": "Restore Volume on Unmute", "text": "Shall restore volume.", "tags": []},
            {"temp_id": "n6", "type": "Requirement", "parent_temp_id": "n4", "title": "Volume Change While Muted", "text": "Shall allow changes.", "tags": []},
        ]
    )
    tree = build_survey_tree(doc, fake)
    assert not any("attached under the wrong ancestor" in w.raw for w in tree.warnings)


def test_repair_group_attachment_does_not_repair_when_correct_parent_node_is_missing() -> None:
    # The group's own node exists, but the node matching its known correct
    # parent_label was never generated at all -- nothing correct to
    # re-parent to. Must not guess/synthesize; the separate coverage-check
    # warning already reports Audio Control as missing.
    #
    # Tested directly (see the first converted test's docstring above for
    # why an end-to-end table fixture can no longer reach this function).
    nodes = [
        # "Audio Control" itself never became its own node.
        _node("n1", WorkItemType.REQUIREMENT, None, "Adjust Volume Level"),
        _node("n4", WorkItemType.REQUIREMENT, "n1", "Mute Behavior"),
        _node("n5", WorkItemType.REQUIREMENT, "n4", "Restore Volume on Unmute"),
        _node("n6", WorkItemType.REQUIREMENT, "n4", "Volume Change While Muted"),
    ]
    table_groups = [
        TableGroupInfo(label="Mute Behavior", child_count=2, id_text="1.2", suggested_type="Requirement", parent_label="Audio Control"),
    ]
    warnings: list[str] = []
    _repair_group_attachment(nodes, table_groups, "", warnings)
    mute_node = next(n for n in nodes if n.title == "Mute Behavior")
    volume_control_node = next(n for n in nodes if n.title == "Adjust Volume Level")
    # Left exactly where the model put it -- no repair attempted.
    assert mute_node.parent_local_id == volume_control_node.local_id
    assert not any("attached under the wrong ancestor" in w.raw for w in warnings)


def test_group_label_became_a_node_is_not_fooled_by_a_single_common_word() -> None:
    # Confirmed live: the pre-fix fractional-overlap check silently
    # swallowed 2 of 3 genuinely-missing Epics because each shared exactly
    # ONE common word with an unrelated node's title ("settings" /
    # "description") -- the coverage-check warning must now correctly fire.
    #
    # Tested directly against _group_label_became_a_node (see the first
    # converted test's docstring above for why an end-to-end table
    # fixture can no longer reach this via build_survey_tree for a fully
    # qualifying table).
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "Audio Control Settings"),
        _node("n1", WorkItemType.REQUIREMENT, "n0", "Do A"),
    ]
    assert not _group_label_became_a_node("System Settings and User Experience", nodes)


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
                    id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]],
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
    zero_node_warnings = [w for w in tree.warnings if "produced 0 work items" in w.raw]
    assert len(zero_node_warnings) == 2  # both branches returned zero nodes
    # Section labels, not internal branch ids ("br0"/"br1") -- see
    # _two_branch_doc's own fixture headings.
    assert "Display" in zero_node_warnings[0].raw
    assert "Audio" in zero_node_warnings[1].raw


def test_build_survey_tree_does_not_warn_about_zero_nodes_when_a_branch_genuinely_has_none(monkeypatch) -> None:
    # A branch with NO real content (no blocks/tables/figures at all) isn't
    # a failure -- nothing to warn about.
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(_two_branch_doc(), fake)
    assert not any("produced 0 work items" in w.raw for w in tree.warnings)


def test_build_survey_tree_does_not_warn_about_tables_on_the_single_branch_path() -> None:
    # Single-branch path DOES place tables/figures correctly (passed
    # directly to _build_survey_tree_for_branch) -- no warning expected.
    path = "table_only.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]], source_ref=_sr(path))],
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


class _PerSectionSectionAnalysisClient:
    """Test double whose analyze_section response depends on the section
    TEXT it receives (branch 0's "Display" section vs branch 1's "Audio"
    section), unlike FakeSectionAnalysisClient's fixed response -- needed
    to prove the final tree's node order reflects DOCUMENT order, not
    completion order, once branches run concurrently. `delay_by_keyword`
    (keyword -> seconds) optionally sleeps before returning, so a test can
    force branch 1 to finish before branch 0 despite branch 0 being
    submitted first."""

    def __init__(self, delay_by_keyword: dict[str, float] | None = None) -> None:
        self.calls: list[str] = []
        self._delay_by_keyword = delay_by_keyword or {}

    def analyze_section(self, section_text: str, **_kwargs) -> tuple[list[dict], bool]:
        self.calls.append(section_text)
        # "5.1 surround" is branch 1 (Audio)-only content -- the doesn't-fit
        # path's compact document outline (see build_survey_tree's §3.3)
        # prepends EVERY section's heading name to every branch's own call,
        # so a bare "Display"/"Audio" substring check would false-match on
        # both branches; this fragment only ever appears in branch 1's own
        # detail text.
        keyword = "Audio" if "5.1 surround" in section_text else "Display"
        for delay_keyword, seconds in self._delay_by_keyword.items():
            if delay_keyword == keyword:
                time.sleep(seconds)
        return (
            [
                {
                    "temp_id": "n0", "type": "Feature", "parent_temp_id": None,
                    "title": keyword, "text": f"The system shall handle: {keyword}", "tags": [],
                },
            ],
            False,
        )


def test_build_survey_tree_concurrent_branches_produce_the_same_tree_as_sequential(monkeypatch) -> None:
    # Regression guard for the branch_concurrency feature: running branches
    # concurrently must never change WHAT gets built, only how long it
    # takes. Same document, same fake client behavior, branch_concurrency=1
    # vs 2 -- the resulting node lists (content AND order) must match
    # exactly.
    _force_multi_branch(monkeypatch)
    doc = _two_branch_doc()

    sequential_tree = build_survey_tree(doc, _PerSectionSectionAnalysisClient(), branch_concurrency=1)
    concurrent_tree = build_survey_tree(doc, _PerSectionSectionAnalysisClient(), branch_concurrency=2)

    assert [(n.local_id, n.title) for n in sequential_tree.nodes] == [(n.local_id, n.title) for n in concurrent_tree.nodes]
    assert [n.title for n in concurrent_tree.nodes] == ["Display", "Audio"]  # document order, not alphabetical/call order


def test_build_survey_tree_concurrent_branches_preserve_document_order_even_when_branch_0_finishes_last(monkeypatch) -> None:
    # The real risk this guards against: branch 0 is submitted FIRST but
    # artificially delayed so branch 1 genuinely completes first. Node
    # order in the final tree must still be branch 0's nodes before branch
    # 1's -- proving results are assembled by branch INDEX, not by
    # whichever future resolves first.
    _force_multi_branch(monkeypatch)
    fake = _PerSectionSectionAnalysisClient(delay_by_keyword={"Display": 0.2})
    tree = build_survey_tree(_two_branch_doc(), fake, branch_concurrency=2)

    assert [n.title for n in tree.nodes] == ["Display", "Audio"]
    assert len(fake.calls) == 2


def test_build_survey_tree_concurrency_reports_correct_per_branch_blocks_done_before(monkeypatch) -> None:
    # Regression: blocks_done_before used to be a running counter mutated
    # AFTER each branch finished, which is unsafe once branches can finish
    # out of order. Must now be each branch's fixed, precomputed offset
    # regardless of concurrency or completion order.
    _force_multi_branch(monkeypatch)
    events: list[LevelingProgress] = []
    build_survey_tree(
        _two_branch_doc(), FakeSectionAnalysisClient(),
        progress_callback=lambda p: events.append(p),
        branch_concurrency=2,
    )

    section_events = [e for e in events if e.phase == "analyze_section" and e.branch_index is not None]
    by_branch = {e.branch_index: e.blocks_done for e in section_events}
    # Branch 0 is blocks 0-1 (heading + requirement), branch 1 starts at 2.
    assert by_branch.get(0) == 0
    assert by_branch.get(1) == 2


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
    assert any("low grounding" in w.raw for w in tree.warnings)


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


def test_score_epics_and_features_excludes_a_per_epic_bridge_feature() -> None:
    # Regression: the deterministic-path reparent fix (Phase 1) changed a
    # per-Epic bridge Feature's local_id from the shared
    # "..._synth_feature" to "..._synth_feature_{epic_local_id}" (see
    # ensure_bridge_feature) so each Epic gets its OWN bridge instead of
    # sharing one document-global bridge -- but the scoring-exclusion
    # check here originally used `.endswith("synth_feature")`, which no
    # longer matches the per-Epic variant (it ends with the epic's own
    # id, not the literal string "synth_feature"). Confirmed this would
    # have silently sent every per-Epic bridge Feature to real Epic/
    # Feature quality review, scoring a mechanically-inserted node as if
    # it were a real authorial decision.
    from app.leveling.llm_leveling import _score_epics_and_features

    class _RecordingScoringClient:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def score_epics_and_features_for_document(self, nodes_by_id):
            self.calls.append(nodes_by_id)
            return {node_id: {"score": 50, "categoryScores": {}} for node_id in nodes_by_id}

    epic = WorkItemNode(
        local_id="det0_h1", type=WorkItemType.EPIC, parent_local_id=None, title="Epic A",
        description="Epic A", source_ref=_sr("x.docx"), mode=WorkItemMode.SURVEY,
    )
    per_epic_bridge = WorkItemNode(
        local_id="det0_synth_feature_det0_h1", type=WorkItemType.FEATURE, parent_local_id="det0_h1",
        title="(auto-grouped) ...", description="Auto-inserted grouping Feature -- ...",
        source_ref=_sr("x.docx"), mode=WorkItemMode.SURVEY,
    )
    scoring_client = _RecordingScoringClient()
    warnings: list[str] = []

    _score_epics_and_features([epic, per_epic_bridge], scoring_client, warnings, None, None, 0, 0)

    assert len(scoring_client.calls) == 1
    assert "det0_synth_feature_det0_h1" not in scoring_client.calls[0]
    assert per_epic_bridge.quality_score is None


def test_build_survey_tree_requirement_scoring_failure_is_caught_and_warned() -> None:
    # Regression: a real job (ba8c26d1-...) lost 45+ minutes of prior
    # parse/tree-build/title-tag/synthesis work to a single transient 500
    # from the LLM backend inside _score_all_requirements, which had no
    # fail-open protection -- unlike its sibling _score_epics_and_features
    # (see test_build_survey_tree_epic_feature_scoring_failure_is_caught_and_warned
    # immediately below). Requirement quality scoring is an enhancement on
    # top of an already-built tree, never a dependency of its correctness.
    class _RaisingRequirementScoringClient(FakeScoringClient):
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            raise ValueError("boom")

    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), _RaisingRequirementScoringClient())

    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n1"].quality_score is None  # failed -- but the job itself did not fail
    assert any("Requirement quality scoring failed" in w.raw for w in tree.warnings)


def test_build_survey_tree_requirement_scoring_failure_fires_chunk_warning() -> None:
    # docs/ui-progress-review.md item #3: this failure must be visible LIVE
    # (via progress_callback), not just in the final tree.warnings list.
    class _RaisingRequirementScoringClient(FakeScoringClient):
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            raise ValueError("boom")

    fired: list[LevelingProgress] = []
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), _RaisingRequirementScoringClient(),
        progress_callback=fired.append,
    )

    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert any(chunk_warnings[0].warning_message == w.raw for w in tree.warnings)


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
    assert any("Epic/Feature quality scoring failed" in w.raw for w in tree.warnings)


def test_build_survey_tree_epic_feature_scoring_failure_fires_chunk_warning() -> None:
    class _RaisingEpicFeatureClient(FakeScoringClient):
        def score_epics_and_features_for_document(self, nodes_by_id):
            raise ValueError("boom")

    fired: list[LevelingProgress] = []
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(), _RaisingEpicFeatureClient(),
        progress_callback=fired.append,
    )

    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert any(chunk_warnings[0].warning_message == w.raw for w in tree.warnings)


def test_apply_quality_scores_missing_score_fires_chunk_warning() -> None:
    from app.leveling.scoring import _apply_quality_scores

    class _EmptyScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            return {}  # every node comes back with no valid score

    nodes = [_req_node("n1", "The system shall do x.")]
    warnings: list[str] = []
    fired: list[LevelingProgress] = []

    _apply_quality_scores(nodes, _EmptyScoringClient(), warnings, "", progress_callback=fired.append)

    assert "returned no valid score" in warnings[0].raw
    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert chunk_warnings[0].warning_message == warnings[0].raw


def test_apply_quality_scores_inconsistent_categories_fires_chunk_warning() -> None:
    from app.leveling.scoring import _apply_quality_scores

    class _InconsistentCategoriesClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            return {
                "n1": {"score": 80, "issues": [], "categoryScores": {"clarity": 80}},
                "n2": {"score": 70, "issues": [], "categoryScores": {"rationale": 70}},
            }

    nodes = [_req_node("n1", "The system shall do x."), _req_node("n2", "The system shall do y.")]
    warnings: list[str] = []
    fired: list[LevelingProgress] = []

    _apply_quality_scores(nodes, _InconsistentCategoriesClient(), warnings, "", progress_callback=fired.append)

    assert any("2 different sets of category names" in w.raw for w in warnings)
    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert "2 different sets of category names" in chunk_warnings[0].warning_message


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


def test_build_survey_tree_carries_the_matched_checklist_definitions_through_to_the_node(tmp_path, monkeypatch) -> None:
    # End-to-end: KbVectorStore's stored quality_checklist_definitions_json
    # (the companion to quality_checklist_json, see
    # OrchestratorLlmClient.extract_quality_checklist_definitions's own
    # docstring) reaches the scored node's quality_category_checklist,
    # matched against whatever categoryScores keys the scoring client
    # actually returned -- see _match_category_checklist.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [{"source_file": "standard.pdf", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    vector_store.upsert_chunk(
        chunk_id="s1:standard.pdf:0", embedding=[1.0, 0.0, 0.0], text="checklist text", user_id="Project\\Area1",
        source_file="standard.pdf", source_id="s1", chunk_index=0, file_hash="h1",
        quality_checklist=["Necessary", "Unambiguous"],
        quality_checklist_definitions={"Necessary": "States something not already satisfied."},
    )

    class _CapturingScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            return {
                node_id: {"score": 90, "issues": [], "categoryScores": {"Necessary": 80, "Unambiguous": 70}}
                for node_id in descriptions_by_node_id
            }

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[{"source_file": "standard.pdf", "similarity": 0.9, "text": "checklist text"}],
    )
    tree = build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=vector_store,
        model="qwen3:4b",
        scoring_client=_CapturingScoringClient(),
    )

    by_id = {node.local_id: node for node in tree.nodes}
    n0 = by_id["n0"]
    assert n0.quality_category_scores == {"Necessary": 80, "Unambiguous": 70}
    # Only "Necessary" has a stored definition -- "Unambiguous" is a real,
    # expected non-match (bare name, no separate definition text), not a
    # missing/failed lookup.
    assert n0.quality_category_checklist == {"Necessary": "States something not already satisfied."}


def test_build_survey_tree_leaves_checklist_none_when_no_definitions_were_ever_extracted(tmp_path, monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [{"source_file": "standard.pdf", "distance": 0.1, "similarity": 0.9, "text": "agentic KB text"}]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    # quality_checklist stored, but the definitions companion never was --
    # e.g. ingested before extract_quality_checklist_definitions existed.
    vector_store.upsert_chunk(
        chunk_id="s1:standard.pdf:0", embedding=[1.0, 0.0, 0.0], text="checklist text", user_id="Project\\Area1",
        source_file="standard.pdf", source_id="s1", chunk_index=0, file_hash="h1",
        quality_checklist=["Necessary", "Unambiguous"],
    )

    class _CapturingScoringClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None):
            return {
                node_id: {"score": 90, "issues": [], "categoryScores": {"Necessary": 80}}
                for node_id in descriptions_by_node_id
            }

    fake = FakeSectionAnalysisClient(
        agentic_nodes=[{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The display shall support HDR.", "tags": []}],
        agentic_citations=[{"source_file": "standard.pdf", "similarity": 0.9, "text": "checklist text"}],
    )
    tree = build_survey_tree(
        _small_doc(),
        fake,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=vector_store,
        model="qwen3:4b",
        scoring_client=_CapturingScoringClient(),
    )

    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n0"].quality_category_checklist is None


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
    assert any("no valid score" in w.raw for w in tree.warnings)


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
    # per branch as before. br0_n1/br1_n1 share IDENTICAL description text
    # (FakeSectionAnalysisClient's default fixture), so cross-branch
    # deduplication-before-chunking (see _score_all_requirements' own
    # docstring) means only ONE of them is actually sent to the model --
    # the other gets the same result copied over, not a second LLM
    # judgment of the same text.
    _force_multi_branch(monkeypatch)
    scoring_client = FakeScoringClient()
    tree = build_survey_tree(_two_branch_doc(), FakeSectionAnalysisClient(), scoring_client)
    assert len(scoring_client.calls) == 1
    assert len(scoring_client.calls[0]) == 1  # only one representative sent, not both duplicates
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["br0_n1"].quality_score is not None
    assert by_id["br1_n1"].quality_score is not None
    assert by_id["br0_n1"].quality_score == by_id["br1_n1"].quality_score  # fanned out, same result


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
    assert any("invalid type" in w.raw for w in tree.warnings)


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
    from app.leveling.model_caps import _resolve_caps

    caps = _resolve_caps("qwen3:4b")
    assert caps.supports_tools is True


def test_resolve_caps_qwen2_5_32b_instruct_uses_the_empirically_tested_coverage_budget() -> None:
    # Regression/documentation: confirmed live against the real 682-block
    # AirPro ICD that this model's dropped-block rate roughly HALVES at
    # coverage_budget_tokens=20_000 vs the shared local-model default of
    # 10_000 (45% -> 23%), with MORE nodes produced (not fewer) and faster
    # overall wall time -- a genuinely tested value, not an assumption from
    # this model's larger parameter count or context window alone.
    from app.leveling.model_caps import _resolve_caps

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
    from app.leveling.model_caps import _resolve_caps

    caps = _resolve_caps("qwen3.6:35b")
    assert caps.supports_tools is True
    assert caps.coverage_budget_tokens == 20_000
    assert caps.context_budget_tokens == 32_000


def test_resolve_caps_unknown_model_defaults_to_no_tools() -> None:
    from app.leveling.model_caps import _resolve_caps

    caps = _resolve_caps("some-random-model")
    assert caps.supports_tools is False
    assert caps.branch_cap > 0


def test_resolve_caps_frontier_prefix_gets_large_cap_and_tools() -> None:
    from app.leveling.model_caps import _resolve_caps

    caps = _resolve_caps("gpt-5-turbo")
    assert caps.supports_tools is True
    assert caps.branch_cap == 100_000


# --- live per-model capability lookup (ModelCapsClient) ----------------------
#
# Real gap closed: an unknown model previously got the same blanket
# conservative guess (context=28_000, coverage=_COVERAGE_BUDGET_TOKENS,
# supports_tools=False) regardless of what it actually is. caps_client is
# optional (default None, byte-identical to every test above) -- only
# applies to a model NOT already in _MODEL_CAPS and not frontier-prefixed.


class _FakeCapsClient:
    def __init__(self, response: dict | None = None, raises: bool = False) -> None:
        self._response = response or {"context_length": 64_000, "capabilities": ["completion", "tools"]}
        self._raises = raises
        self.call_count = 0

    def show_model(self, model: str) -> dict:
        self.call_count += 1
        if self._raises:
            raise RuntimeError("orchestrator unreachable")
        return self._response


def test_resolve_caps_unknown_model_uses_live_lookup_when_caps_client_supplied() -> None:
    from app.leveling.model_caps import _resolve_caps

    fake_client = _FakeCapsClient({"context_length": 64_000, "capabilities": ["completion", "tools"]})
    caps = _resolve_caps("some-fresh-model-v9", caps_client=fake_client)

    assert caps.context_budget_tokens == 64_000
    assert caps.supports_tools is True
    assert fake_client.call_count == 1


def test_resolve_caps_live_lookup_result_is_cached_for_the_process_lifetime() -> None:
    from app.leveling.model_caps import _resolve_caps

    fake_client = _FakeCapsClient({"context_length": 40_000, "capabilities": ["completion"]})
    first = _resolve_caps("some-cached-model-v9", caps_client=fake_client)
    second = _resolve_caps("some-cached-model-v9", caps_client=fake_client)

    assert first == second
    assert fake_client.call_count == 1  # second call hit the cache, not a second live lookup


def test_resolve_caps_live_lookup_at_frontier_threshold_gets_frontier_shaped_caps() -> None:
    from app.leveling.model_caps import _resolve_caps

    fake_client = _FakeCapsClient({"context_length": 200_000, "capabilities": ["completion", "tools"]})
    caps = _resolve_caps("some-huge-model-v9", caps_client=fake_client)

    assert caps.context_budget_tokens == 200_000
    assert caps.coverage_budget_tokens == caps.context_budget_tokens  # no lost-in-the-middle guard at this scale
    assert caps.branch_cap == 100_000


def test_resolve_caps_live_lookup_below_frontier_threshold_keeps_conservative_local_defaults() -> None:
    from app.leveling.model_caps import _resolve_caps, _COVERAGE_BUDGET_TOKENS, _MAX_SURVEY_BRANCH_BLOCK_COUNT

    fake_client = _FakeCapsClient({"context_length": 32_000, "capabilities": ["completion", "tools"]})
    caps = _resolve_caps("some-modest-model-v9", caps_client=fake_client)

    assert caps.context_budget_tokens == 32_000
    assert caps.coverage_budget_tokens == _COVERAGE_BUDGET_TOKENS  # the lost-in-the-middle guard stays on
    assert caps.branch_cap == _MAX_SURVEY_BRANCH_BLOCK_COUNT
    assert caps.supports_tools is True


def test_resolve_caps_live_lookup_failure_falls_back_to_exactly_the_static_default() -> None:
    from app.leveling.model_caps import _resolve_caps

    without_client = _resolve_caps("some-raising-model-v9")
    fake_client = _FakeCapsClient(raises=True)
    with_raising_client = _resolve_caps("some-raising-model-v9", caps_client=fake_client)

    assert with_raising_client == without_client
    assert fake_client.call_count == 1


def test_resolve_caps_never_calls_the_live_client_for_a_model_already_in_the_static_table() -> None:
    # This is the guarantee that protects every empirically-tuned model
    # (qwen3.6:35b, qwen2.5:32b-instruct, ...) from being second-guessed
    # by a generic derivation -- the static table always wins when it has
    # an entry, no matter what caps_client would have returned.
    from app.leveling.model_caps import _resolve_caps

    fake_client = _FakeCapsClient({"context_length": 1, "capabilities": []})  # would produce very different caps
    caps = _resolve_caps("qwen3.6:35b", caps_client=fake_client)

    assert caps.coverage_budget_tokens == 20_000  # the real static-table value, untouched
    assert fake_client.call_count == 0


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


def test_build_survey_tree_drops_a_trace_link_between_a_node_and_its_own_parent() -> None:
    # CONFIRMED REAL BUG, found via live testing: infer_trace_links has no
    # structural signal telling it two nodes are already directly related
    # via the tree's own parent/child hierarchy (a separate field, never
    # part of the llm_nodes payload the model sees) -- it proposed an
    # "Affects" link from a parent requirement straight to its own child,
    # which confirm() then wrote as a SECOND, fully redundant ADO link
    # alongside the real Parent/Child hierarchy link already covering the
    # exact same pair (ADO's Related Work panel showed both "Child" and
    # "Affects" listing the identical work item). n0 is n1's parent per
    # _DEFAULT_NODES -- both directions must be dropped.
    catalog = [{"reference_name": "Microsoft.VSTS.Common.Affects-Forward", "name": "Affects", "semantic_hint": None}]
    fake_client = FakeTraceLinkInferenceClient(
        results=[
            {"source_node_id": "n0", "reference_name": "Microsoft.VSTS.Common.Affects-Forward", "target_ref": "n1"},
            {"source_node_id": "n1", "reference_name": "Microsoft.VSTS.Common.Affects-Forward", "target_ref": "n0"},
        ]
    )
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert tree.trace_links == []


def test_build_survey_tree_drops_a_self_referencing_trace_link() -> None:
    catalog = [{"reference_name": "Microsoft.VSTS.Common.Affects-Forward", "name": "Affects", "semantic_hint": None}]
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "n1", "reference_name": "Microsoft.VSTS.Common.Affects-Forward", "target_ref": "n1"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert tree.trace_links == []


def test_build_survey_tree_keeps_a_trace_link_between_non_hierarchy_related_nodes() -> None:
    # Regression guard for the parent/child filter above: it must only drop
    # a DIRECT parent/child pair, not trace links in general -- two
    # siblings (both children of the same root, neither one the other's
    # parent) are a legitimate trace/coverage relationship and must survive.
    catalog = [{"reference_name": "Microsoft.VSTS.Common.Affects-Forward", "name": "Affects", "semantic_hint": None}]
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "s1", "reference_name": "Microsoft.VSTS.Common.Affects-Forward", "target_ref": "s2"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(nodes=_SIBLING_NODES),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(tree.trace_links) == 1
    assert tree.trace_links[0].source_local_id == "s1"
    assert tree.trace_links[0].target_local_id == "s2"


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
    assert any("Trace/coverage link inference failed" in w.raw for w in tree.warnings)


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
    # s1/s2 are siblings (both children of root s0), not a parent/child
    # pair -- see _SIBLING_NODES' own comment for why this test can't use
    # _DEFAULT_NODES' n0/n1 anymore.
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "s1", "target_ref": "s2", "reference_name": "System.LinkTypes.Related"}]
    )
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(nodes=_SIBLING_NODES),
        link_type_client=fake_client, link_type_catalog=[],
    )
    assert len(tree.trace_links) == 1
    link = tree.trace_links[0]
    assert link.source_local_id == "s1"
    assert link.target_kind == "intraJob"
    assert link.target_local_id == "s2"
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
            {"source_node_id": "s1", "target_ref": "s2", "reference_name": "Hallucinated.NotReal"},
            {"source_node_id": "s1", "target_ref": "s2", "reference_name": "System.LinkTypes.Related"},
        ]
    )
    catalog = [{"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}]
    tree = build_survey_tree(
        _small_doc(), FakeSectionAnalysisClient(nodes=_SIBLING_NODES),
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
    import app.leveling.model_caps as model_caps_module

    monkeypatch.setattr(model_caps_module, "_MAX_SURVEY_BRANCH_BLOCK_COUNT", 3)
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
            topic_count: int | None = None, table_group_hints: list[tuple[str, str]] | None = None,
            expected_root_count: int | None = None,
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
    first_section_event = next(e for e in events if e.branch_index is not None)
    assert first_section_event.section_label == "Display"  # first block's own text


def test_build_survey_tree_progress_callback_falls_back_to_a_tables_caption_for_a_blocks_empty_branch() -> None:
    path = "sheet.xlsx"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.XLSX, sha256="h"),
        blocks=[],
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]], caption="Sheet1", source_ref=_sr(path))],
    )
    events = []
    build_survey_tree(doc, FakeSectionAnalysisClient(), progress_callback=lambda p: events.append(p))
    first_section_event = next(e for e in events if e.branch_index is not None)
    assert first_section_event.section_label == "Sheet1"


def test_build_survey_tree_fires_progress_callback_for_each_real_step_boundary() -> None:
    events = []

    tree = build_survey_tree(
        _small_doc(),
        FakeSectionAnalysisClient(),
        progress_callback=lambda p: events.append(p),
    )

    phases = [e.phase for e in events]
    # preparing_analysis fires first (see its own docstring) -- whole-tree,
    # no section/branch context yet, so it's excluded from the per-section
    # branch_index/branch_count assertions below.
    assert phases == ["preparing_analysis", "analyze_section", "section_complete"]
    section_events = events[1:]
    assert all(e.branch_index == 0 for e in section_events)
    assert all(e.branch_count == 1 for e in section_events)
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
        "preparing_analysis",
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


def test_render_section_injects_the_real_figure_id_into_the_rendered_line() -> None:
    # known-issues item 20: the model has no id to name in figure_ids
    # unless render_section actually puts one in the text it reads.
    path = "x.docx"
    block = Block(id="b5", kind=BlockKind.FIGURE, text="[FIGURE: A power schematic]", source_ref=_sr(path))
    text = render_section([block], figure_id_by_block_id={"b5": "f3"})
    assert "> Figure f3: A power schematic" in text


def test_render_section_omits_the_figure_id_when_no_map_is_supplied() -> None:
    # None is byte-identical to before figure_id_by_block_id existed --
    # _figure_line/block.text (shared with BASELINE) are never touched.
    path = "x.docx"
    block = Block(id="b5", kind=BlockKind.FIGURE, text="[FIGURE: A power schematic]", source_ref=_sr(path))
    text = render_section([block])
    assert "> Figure: A power schematic" in text
    assert "f3" not in text


def test_render_section_prefixes_each_table_with_its_own_id_marker() -> None:
    # Unlike figures, no id map is needed here -- table.id is already
    # directly available from the `tables` list itself.
    path = "x.docx"
    table = Table(id="t2", cells=[[TableCell(text=c) for c in row] for row in [["h1", "h2"], ["a", "b"]]], source_ref=_sr(path))
    text = render_section([], tables=[table])
    assert "[TABLE t2]" in text
    assert text.index("[TABLE t2]") < text.index("| h1 | h2 |")


def test_build_survey_tree_embeds_a_named_tables_html_and_records_table_ids() -> None:
    # known-issues item 20, piece (c): once a node names a real table_id,
    # that table's HTML is embedded into its description -- no new ADO
    # write capability needed, unlike figures (see WorkItemNode.table_ids'
    # own docstring).
    path = "table_only.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]], source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{
            "temp_id": "n0", "type": "Requirement", "parent_temp_id": None,
            "title": "t", "text": "The system shall do x.", "tags": [],
            "table_ids": ["t0"],
        }]
    )
    tree = build_survey_tree(doc, fake)
    assert len(tree.nodes) == 1
    node = tree.nodes[0]
    assert node.table_ids == ["t0"]
    assert node.description.startswith("The system shall do x.")
    assert "<table>" in node.description
    assert "<td>a</td>" in node.description


def test_build_survey_tree_drops_a_hallucinated_table_id_and_warns() -> None:
    # A model-returned id that doesn't match any real table this section
    # actually offered must never be trusted verbatim -- dropped, with a
    # warning surfaced for review, not silently accepted.
    path = "table_only.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        tables=[Table(id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]], source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{
            "temp_id": "n0", "type": "Requirement", "parent_temp_id": None,
            "title": "t", "text": "The system shall do x.", "tags": [],
            "table_ids": ["t99"],
        }]
    )
    tree = build_survey_tree(doc, fake)
    node = tree.nodes[0]
    assert node.table_ids == []
    assert "<table>" not in node.description
    assert any('"t" referenced 1 table(s) not offered in this section' in w.raw for w in tree.warnings)


def test_build_survey_tree_drops_a_valid_table_id_with_no_extractable_content_and_warns() -> None:
    # A model-named table_id can pass the hallucination filter (it's a REAL
    # table this branch actually offered) yet still render empty HTML --
    # _table_to_html returns "" for a grid with no non-blank cell anywhere.
    # Previously the id was kept in table_ids unconditionally while the
    # HTML was only appended to description `if table_html:`, leaving a
    # table_ids entry with zero corresponding content in description --
    # violating the orchestrator's own documented invariant that a
    # non-empty table_ids list means that table's HTML is already embedded
    # in description. The id must now be dropped from table_ids (together
    # with skipping the description append) and reported via a dedicated
    # EMPTY_TABLE_CONTENT warning instead of silently disappearing.
    path = "table_only.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        tables=[Table(id="t0", cells=[[TableCell(text=""), TableCell(text="")]], source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{
            "temp_id": "n0", "type": "Requirement", "parent_temp_id": None,
            "title": "t", "text": "The system shall do x.", "tags": [],
            "table_ids": ["t0"],
        }]
    )
    tree = build_survey_tree(doc, fake)
    node = tree.nodes[0]
    assert node.table_ids == []
    assert "<table>" not in node.description
    assert "t0" not in node.description
    warning = next(w for w in tree.warnings if w.kind == WarningKind.EMPTY_TABLE_CONTENT)
    assert warning.node_ids == [node.local_id]
    assert warning.detail["tableId"] == "t0"


def test_build_survey_tree_records_figure_ids_named_by_the_model() -> None:
    path = "figure_only.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.FIGURE, text="[FIGURE: A wiring diagram]", source_ref=_sr(path))],
        figures=[Figure(id="f0", caption="A wiring diagram", source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{
            "temp_id": "n0", "type": "Requirement", "parent_temp_id": None,
            "title": "t", "text": "The system shall do x.", "tags": [],
            "figure_ids": ["f0"],
        }]
    )
    tree = build_survey_tree(doc, fake)
    assert tree.nodes[0].figure_ids == ["f0"]


def test_build_survey_tree_drops_a_hallucinated_figure_id_and_warns() -> None:
    path = "figure_only.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.FIGURE, text="[FIGURE: A wiring diagram]", source_ref=_sr(path))],
        figures=[Figure(id="f0", caption="A wiring diagram", source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{
            "temp_id": "n0", "type": "Requirement", "parent_temp_id": None,
            "title": "t", "text": "The system shall do x.", "tags": [],
            "figure_ids": ["f99"],
        }]
    )
    tree = build_survey_tree(doc, fake)
    assert tree.nodes[0].figure_ids == []
    assert any('"t" referenced 1 figure(s) not offered in this section' in w.raw for w in tree.warnings)


def test_build_survey_tree_scopes_table_ids_validation_per_branch(monkeypatch) -> None:
    # The multi-branch path never passes `figures=`/a per-branch table list
    # to _build_survey_tree_for_branch the same simple way the single-branch
    # path does (see _run_branch) -- this proves table_ids validation still
    # correctly scopes to EACH branch's own real tables (via
    # _partition_tables_by_branch), not the whole document's. Both branches
    # get the identical FakeSectionAnalysisClient node claiming "t0", but
    # only branch 2 ("Audio") actually has that table in its own section.
    _force_multi_branch(monkeypatch)
    doc = _two_branch_doc()
    doc = doc.model_copy(
        update={
            "tables": [
                Table(
                    id="t0", cells=[[TableCell(text=c) for c in row] for row in [["a", "b"]]],
                    source_ref=SourceRef(document_path=doc.document.path, start_offset=20, end_offset=30),
                )
            ]
        }
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{
            "temp_id": "n0", "type": "Requirement", "parent_temp_id": None,
            "title": "t", "text": "The system shall do x.", "tags": [], "table_ids": ["t0"],
        }]
    )
    tree = build_survey_tree(doc, fake)
    display_node = next(n for n in tree.nodes if n.local_id == "br0_n0")
    audio_node = next(n for n in tree.nodes if n.local_id == "br1_n0")
    assert display_node.table_ids == []
    assert "<table>" not in display_node.description
    assert audio_node.table_ids == ["t0"]
    assert "<table>" in audio_node.description


def test_build_survey_tree_scopes_figure_ids_validation_per_branch(monkeypatch) -> None:
    # Same guarantee as the table test above, for figures -- the global
    # figure_id_by_block_id map is whole-document, but valid_figure_ids is
    # derived from each branch's OWN `blocks`, so a figure belonging to a
    # DIFFERENT branch is correctly rejected here too.
    _force_multi_branch(monkeypatch)
    path = "two_branch_survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.FIGURE, text="[FIGURE: A display wiring diagram]", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
        ],
        figures=[Figure(id="f0", caption="A display wiring diagram", source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[{
            "temp_id": "n0", "type": "Requirement", "parent_temp_id": None,
            "title": "t", "text": "The system shall do x.", "tags": [], "figure_ids": ["f0"],
        }]
    )
    tree = build_survey_tree(doc, fake)
    display_node = next(n for n in tree.nodes if n.local_id == "br0_n0")
    audio_node = next(n for n in tree.nodes if n.local_id == "br1_n0")
    assert display_node.figure_ids == ["f0"]
    assert audio_node.figure_ids == []


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
    assert any("ReqID 12345" in w.raw and "did not ingest" in w.raw for w in tree.warnings)


def test_build_survey_tree_does_not_warn_on_a_section_with_no_attachment_references() -> None:
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    assert not any("did not ingest" in w.raw for w in tree.warnings)


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
    assert any("ReqID" in w.raw and "did not ingest" in w.raw for w in tree.warnings)


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
    assert any("did not ingest" in w.raw for w in tree.warnings)
    assert not any("did not reference" in w.raw for w in tree.warnings)


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
                cells=[[TableCell(text=c) for c in row] for row in [["Req ID", "Text"], ["R1", "The unit shall power on within 5 seconds."]]],
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
    # representative ref falls back to the table's own position (document_path/
    # start_offset/end_offset/page) -- section_path is NOT part of that
    # fallback comparison since it's populated separately (from
    # _derive_section_label's table-caption fallback, "Sheet1" here), see
    # the section_path assertion right below.
    node_ref = tree.nodes[0].source_ref
    table_ref = doc.tables[0].source_ref
    assert (node_ref.document_path, node_ref.start_offset, node_ref.end_offset, node_ref.page) == (
        table_ref.document_path, table_ref.start_offset, table_ref.end_offset, table_ref.page,
    )
    assert node_ref.section_path == ["Sheet1"]


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
    assert any('re-parented under Feature "A capability."' in w.raw for w in tree.warnings)


def test_build_survey_tree_keeps_a_child_requirement_parented_under_its_requirement() -> None:
    # Real gap fixed here, live-tested against a reference CMMI structure:
    # a Requirement parented under ANOTHER Requirement is a legitimate child
    # Requirement (exceptions/conditions/follow-up behavior of a general
    # parent, e.g. "Automatic Switching to an Active Source" ->
    # "Multiple Active Sources"/"User Dismisses the Suggestion") -- must be
    # preserved, not re-parented up to the nearest Feature.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "text": "A capability.", "tags": []},
            {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "text": "Shall do X.", "tags": []},
            {"temp_id": "n2", "type": "Requirement", "parent_temp_id": "n1", "text": "Shall do Y.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    by_id = {node.local_id: node for node in tree.nodes}
    assert by_id["n1"].parent_local_id == "n0"
    assert by_id["n2"].parent_local_id == "n1"  # child Requirement preserved, not re-parented
    assert not any("re-parented" in w.raw for w in tree.warnings)


def test_build_survey_tree_reparents_a_requirement_chain_that_bypasses_every_feature() -> None:
    # A Requirement->Requirement chain is only valid when it still resolves
    # to a real Feature ancestor somewhere up the chain -- if it instead
    # runs straight into an Epic (skipping Feature entirely), that's still
    # a genuine violation and must be repaired by walking up to the
    # nearest real Feature elsewhere in the branch.
    fake = FakeSectionAnalysisClient(
        nodes=[
            {"temp_id": "n0", "type": "Epic", "parent_temp_id": None, "text": "System outcome.", "tags": []},
            {"temp_id": "n1", "type": "Feature", "parent_temp_id": "n0", "text": "A capability.", "tags": []},
            {"temp_id": "n2", "type": "Requirement", "parent_temp_id": "n0", "text": "Shall do X.", "tags": []},
            {"temp_id": "n3", "type": "Requirement", "parent_temp_id": "n2", "text": "Shall do Y.", "tags": []},
        ]
    )
    tree = build_survey_tree(_small_doc(), fake)
    by_id = {node.local_id: node for node in tree.nodes}
    # n2 (parented directly under the Epic) gets repaired to the real Feature.
    assert by_id["n2"].parent_local_id == "n1"
    # n3 (parented under n2, now a Requirement -- valid) is untouched.
    assert by_id["n3"].parent_local_id == "n2"
    assert any('re-parented under Feature "A capability."' in w.raw for w in tree.warnings)


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
    assert any("inserted a grouping Feature" in w.raw for w in tree.warnings)


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
    assert not any("re-parented" in w.raw or "synthesized" in w.raw for w in tree.warnings)


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
    assert not any("re-parented" in w.raw or "synthesized" in w.raw for w in tree.warnings)


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


# ---------------------------------------------------------------------------
# Deterministic hierarchy detection pipeline (_detect_deterministic_subtrees)
# ---------------------------------------------------------------------------


def _structural_heading_doc() -> CanonicalDoc:
    """A pure structural-heading document (convention 3 -- no ID text,
    just heading_level nesting + real shall content) that should be
    handled ENTIRELY deterministically, with zero residual content for
    the LLM path."""
    path = "structural_survey_input.txt"

    def h(block_id: str, level: int, text: str) -> Block:
        return Block(id=block_id, kind=BlockKind.HEADING, heading_level=level, text=text, source_ref=_sr(path))

    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            h("b0", 1, "System Domain"),
            h("b1", 2, "The system shall do A."),
            h("b2", 2, "The system shall do B."),
            h("b3", 2, "The system shall do C."),
            h("b4", 2, "The system shall do D."),
            h("b5", 2, "The system shall do E."),
        ],
    )


def test_build_survey_tree_uses_a_live_derived_token_budget_for_the_parent_summary_pass() -> None:
    # End-to-end wiring check: the SAME client passed as parent_summary_client
    # also backs the live per-model caps lookup (ModelCapsClient) when the
    # model isn't in _MODEL_CAPS -- _apply_det_parent_summary must resolve a
    # REAL derived budget from it, not the flat _PARENT_SUMMARY_TOKEN_BUDGET
    # default, and use it to decide how many summarize_parent_nodes calls
    # this document's Epic/Feature nodes need.
    doc = _structural_heading_doc()  # Epic "System Domain" -> 5 Requirement leaves, deterministic end to end

    class FakeParentSummaryAndCapsClient:
        def __init__(self, context_length: int) -> None:
            self.context_length = context_length
            self.summarize_calls: list[dict] = []
            self.show_model_calls: list[str] = []

        def show_model(self, model: str) -> dict:
            self.show_model_calls.append(model)
            return {"context_length": self.context_length, "capabilities": ["completion"]}

        def summarize_parent_nodes(self, nodes_by_id: dict) -> dict:
            self.summarize_calls.append(nodes_by_id)
            return {node_id: {"title": "Synthesized Epic", "description": "Covers A-E."} for node_id in nodes_by_id}

    fake_client = FakeParentSummaryAndCapsClient(context_length=32_000)
    tree = build_survey_tree(
        doc, FakeSectionAnalysisClient(), parent_summary_client=fake_client, model="some-fresh-model-v9-parent-summary",
    )

    assert fake_client.show_model_calls == ["some-fresh-model-v9-parent-summary"]  # live lookup actually happened
    epic = next(n for n in tree.nodes if n.title == "Synthesized Epic")
    assert epic.description == "Covers A-E."


def test_build_survey_tree_never_does_a_live_caps_lookup_for_an_already_tuned_model() -> None:
    # Companion to the above: a model already in _MODEL_CAPS must never
    # trigger show_model at all, protecting every empirically-tuned model's
    # static coverage_budget_tokens from being second-guessed.
    doc = _structural_heading_doc()

    class FakeParentSummaryAndCapsClient:
        def __init__(self) -> None:
            self.show_model_calls: list[str] = []

        def show_model(self, model: str) -> dict:
            self.show_model_calls.append(model)
            return {"context_length": 1, "capabilities": []}

        def summarize_parent_nodes(self, nodes_by_id: dict) -> dict:
            return {node_id: {"title": "Synthesized Epic", "description": "Covers A-E."} for node_id in nodes_by_id}

    fake_client = FakeParentSummaryAndCapsClient()
    build_survey_tree(doc, FakeSectionAnalysisClient(), parent_summary_client=fake_client, model="qwen3.6:35b")

    assert fake_client.show_model_calls == []


def test_build_survey_tree_folds_a_real_figure_caption_deterministically() -> None:
    # Confirmed real bug (user-reported, live review): a FIGURE-kind
    # block's raw wire-format text ("[FIGURE: {caption or 'none'}]") was
    # being folded into a deterministic node's description completely
    # unfiltered, unlike the LLM-analysis path's render_section (which
    # already uses _figure_line for exactly this). A real caption must
    # still fold in, just formatted the same way render_section does.
    path = "structural_survey_input.txt"
    doc = _structural_heading_doc().model_copy(
        update={
            "blocks": [
                *_structural_heading_doc().blocks,
                Block(
                    id="fig0", kind=BlockKind.FIGURE,
                    text="[FIGURE: a wiring diagram of the power supply]", source_ref=_sr(path),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert "> Figure: a wiring diagram of the power supply" in last_leaf.description
    assert "[FIGURE:" not in last_leaf.description  # raw wire format never leaks through


def test_build_survey_tree_drops_a_placeholder_figure_caption_deterministically() -> None:
    # The "none" case -- no real caption (vision disabled, or the vision
    # call found nothing) -- must be silently omitted, never leaked into
    # the description as the literal placeholder string.
    path = "structural_survey_input.txt"
    doc = _structural_heading_doc().model_copy(
        update={
            "blocks": [
                *_structural_heading_doc().blocks,
                Block(
                    id="fig0", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert "[FIGURE" not in last_leaf.description
    assert "none" not in last_leaf.description.lower()


def test_build_survey_tree_deterministic_span_fold_strips_an_unsupported_content_note() -> None:
    # 5th leak site for the "[UNSUPPORTED: ...]" diagnostic-text bug (final
    # whole-branch review finding): _detect_deterministic_subtrees's own
    # heading-span-claiming fold loop (span_text = block.text) never went
    # through _render_block_line/_is_unsupported_content_note like every
    # other fold site, so a NOTE block claimed into a heading's span leaked
    # straight into `description` (bound for ADO) with ZERO warning -- the
    # block was already removed from residual_blocks by
    # claimed_heading_block_ids.add(block.id), so it never reached the
    # LLM/residual path's own UNSUPPORTED_CONTENT_NOTE handling either. This
    # uses _structural_heading_doc() (pure heading nesting, no IDs) so the
    # NOTE block is folded via the deterministic span-fold loop, NOT the
    # headingless-LLM-branch path the two tests above already cover.
    path = "structural_survey_input.txt"
    note_text = "[UNSUPPORTED: page 1 appears multi-column; extraction may misorder text]"
    doc = _structural_heading_doc().model_copy(
        update={
            "blocks": [
                *_structural_heading_doc().blocks,
                Block(id="note0", kind=BlockKind.NOTE, text=note_text, source_ref=_sr(path)),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())

    for node in tree.nodes:
        assert note_text not in (node.description or "")
        assert "[UNSUPPORTED:" not in (node.description or "")
    assert any(w.kind == WarningKind.UNSUPPORTED_CONTENT_NOTE for w in tree.warnings)


def test_build_survey_tree_deterministic_block_span_fold_widens_page_end() -> None:
    # Real page numbers (see app/loaders/docx_pagination.py) only ever
    # arrive on a document's own blocks/tables AFTER page alignment has
    # run -- confirms the heading-span-claiming block fold widens its
    # target's own page_end to cover everything folded into it, not just
    # its own originating heading's page (mirrors
    # test_build_baseline_tree_widens_page_end_when_a_block_folds_into_an_
    # open_node in test_tree_builder.py for the BASELINE fold sites).
    path = "structural_survey_input.txt"
    base_doc = _structural_heading_doc()
    paged_blocks = [
        b.model_copy(update={"source_ref": b.source_ref.model_copy(update={"page": 1, "page_end": 1})})
        for b in base_doc.blocks
    ]
    trailing_block = Block(
        id="trail0", kind=BlockKind.PARAGRAPH, text="Additional clarifying detail for requirement E.",
        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=10, page=3, page_end=3),
    )
    doc = base_doc.model_copy(update={"blocks": [*paged_blocks, trailing_block]})
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.source_ref.page == 1  # the node's own originating page never changes
    assert last_leaf.source_ref.page_end == 3  # widened to cover the folded trailing block


def test_build_survey_tree_deterministic_table_span_fold_widens_page_end() -> None:
    # Companion to the block-span-fold widen test above, for the SEPARATE
    # non-qualifying-table-falls-in-a-heading's-span fold site (a table
    # that does NOT itself qualify as its own ID-hierarchy subtree --
    # contrast with test_build_survey_tree_table_row_subtree_sets_table_
    # ids_and_section_path, which exercises a QUALIFYING table's own
    # separate subtree-building path entirely, not this fold site).
    path = "structural_survey_input.txt"
    base_doc = _structural_heading_doc()
    paged_blocks = [
        b.model_copy(
            update={
                "source_ref": SourceRef(
                    document_path=path, start_offset=i * 10, end_offset=i * 10 + 9, page=1, page_end=1,
                )
            }
        )
        for i, b in enumerate(base_doc.blocks)
    ]
    doc = base_doc.model_copy(
        update={
            "blocks": paged_blocks,
            "tables": [
                Table(
                    id="t0", cells=[[TableCell(text=c) for c in row] for row in [["Note", "See appendix for full rationale."]]],
                    source_ref=SourceRef(document_path=path, start_offset=999, end_offset=1000, page=4, page_end=4),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.source_ref.page == 1
    assert last_leaf.source_ref.page_end == 4


def test_build_survey_tree_deterministic_table_span_fold_drops_a_blank_table_and_warns() -> None:
    # Same invariant, same site as the widen test above, but for a table
    # whose grid is genuinely blank (_table_to_html returns "" for it) --
    # the span-fold used to record table.id in the target's table_ids
    # unconditionally, with no emptiness guard at all (not even the
    # `if table_html:` check the analyze_section post-processing loop had),
    # leaving a table_ids entry with zero corresponding content in
    # description. Mirrors test_build_survey_tree_drops_a_valid_table_id_
    # with_no_extractable_content_and_warns, but for THIS deterministic
    # span-fold site instead of the LLM analyze_section path.
    path = "structural_survey_input.txt"
    base_doc = _structural_heading_doc()
    paged_blocks = [
        b.model_copy(
            update={
                "source_ref": SourceRef(
                    document_path=path, start_offset=i * 10, end_offset=i * 10 + 9, page=1, page_end=1,
                )
            }
        )
        for i, b in enumerate(base_doc.blocks)
    ]
    doc = base_doc.model_copy(
        update={
            "blocks": paged_blocks,
            "tables": [
                Table(
                    id="t0", cells=[[TableCell(text=""), TableCell(text="")]],
                    source_ref=SourceRef(document_path=path, start_offset=999, end_offset=1000, page=4, page_end=4),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.table_ids == []
    assert "<table>" not in last_leaf.description
    assert "t0" not in last_leaf.description
    warning = next(w for w in tree.warnings if w.kind == WarningKind.EMPTY_TABLE_CONTENT)
    assert warning.node_ids == [last_leaf.local_id]
    assert warning.detail["tableId"] == "t0"


# --- section_path / figure_ids / table_ids / uncaptioned_figure_ids (Phase 2) ---


def test_build_survey_tree_deterministic_span_fold_records_figure_ids_and_uncaptioned_figure_ids() -> None:
    # Companion to the two "folds/drops a figure caption deterministically"
    # tests above -- those only prove the DESCRIPTION text; this proves the
    # id lists a real Figure now attributes to the span-claiming target.
    path = "structural_survey_input.txt"
    doc = _structural_heading_doc().model_copy(
        update={
            "blocks": [
                *_structural_heading_doc().blocks,
                Block(id="fig0", kind=BlockKind.FIGURE, text="[FIGURE: a wiring diagram]", source_ref=_sr(path)),
                Block(id="fig1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
            ],
            "figures": [
                Figure(id="f0", caption="a wiring diagram", source_ref=_sr(path)),
                Figure(id="f1", caption=None, source_ref=_sr(path)),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.figure_ids == ["f0"]
    assert last_leaf.uncaptioned_figure_ids == ["f1"]
    assert set(last_leaf.figure_ids).isdisjoint(last_leaf.uncaptioned_figure_ids)


def test_build_survey_tree_deterministic_span_fold_populates_insignificant_figure_ids_as_a_subset() -> None:
    # Task 4b sub-fix (ii), call site 4/5 (_detect_deterministic_subtrees).
    # f1 (caption_status="insignificant") must land in BOTH
    # uncaptioned_figure_ids and insignificant_figure_ids; f2
    # (caption_status="vision_failed") must land in uncaptioned_figure_ids
    # only.
    path = "structural_survey_input.txt"
    doc = _structural_heading_doc().model_copy(
        update={
            "blocks": [
                *_structural_heading_doc().blocks,
                Block(id="fig1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
                Block(id="fig2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
            ],
            "figures": [
                Figure(id="f1", caption=None, caption_status="insignificant", source_ref=_sr(path)),
                Figure(id="f2", caption=None, caption_status="vision_failed", source_ref=_sr(path)),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.uncaptioned_figure_ids == ["f1", "f2"]
    assert last_leaf.insignificant_figure_ids == ["f1"]


def test_build_survey_tree_structural_heading_subtree_sets_section_path() -> None:
    tree = build_survey_tree(_structural_heading_doc(), FakeSectionAnalysisClient())
    root = next(n for n in tree.nodes if n.title == "System Domain")
    leaf = next(n for n in tree.nodes if n.title == "The system shall do A.")
    assert root.source_ref.section_path == []
    assert leaf.source_ref.section_path == ["System Domain"]


def test_build_survey_tree_table_row_subtree_sets_table_ids_and_section_path() -> None:
    # Every node in a table-row subtree came from THAT one Table -- table_ids
    # is that table's id on every node, unconditionally. section_path is
    # seeded with the table's own identity (no caption here, so it falls
    # back to "Table {id}", same convention _build_headingless_tree's own
    # per-table title already uses).
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group([
                    ["Requirement ID", "Requirement / Section"],
                    ["1.1", "External Source Detection"],
                    ["1.1.1", "The system shall detect X."],
                    ["1.1.2", "The system shall detect Y."],
                ])
            ]
        }
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    group_node = next(n for n in tree.nodes if n.title == "External Source Detection")
    leaf = next(n for n in tree.nodes if n.title == "The system shall detect X.")
    assert group_node.table_ids == ["t0"]
    assert leaf.table_ids == ["t0"]
    assert group_node.source_ref.section_path == ["Table t0"]
    assert leaf.source_ref.section_path == ["Table t0", "External Source Detection"]


def test_build_survey_tree_llm_branch_section_path_is_the_sections_own_label() -> None:
    # SURVEY nodes share one coarse, section-level source_ref (see
    # _build_survey_tree_for_branch's own representative_source_ref
    # docstring) -- section_path is a single-element path here (the
    # branch's own _derive_section_label), not a multi-level ancestor
    # chain the way BASELINE/the deterministic path can produce.
    tree = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    for node in tree.nodes:
        assert node.source_ref.section_path == ["Display"]


def test_build_survey_tree_llm_branch_representative_source_ref_reflects_branch_page_range() -> None:
    # Task 1b: representative_source_ref used to pass blocks[0]'s own
    # page/page_end through VERBATIM (see _build_survey_tree_for_branch's
    # docstring) -- every node synthesized from this branch shared that one
    # first block's page even though the branch's real content spans many
    # more pages. _widen_branch_page_range now computes page/page_end as
    # min/max over ALL the branch's blocks (mirrors tree_builder.py's
    # _widen_page_end max-page_end pattern, applied once per branch here
    # instead of per fold) -- a real range, not a single coarse page.
    path = "survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0", kind=BlockKind.PARAGRAPH, text="Display",
                source_ref=SourceRef(document_path=path, start_offset=0, end_offset=10, page=3, page_end=3),
            ),
            Block(
                id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.",
                source_ref=SourceRef(document_path=path, start_offset=10, end_offset=20, page=5, page_end=5),
            ),
            Block(
                id="b2", kind=BlockKind.PARAGRAPH, text="Additional clarifying detail.",
                source_ref=SourceRef(document_path=path, start_offset=20, end_offset=30, page=8, page_end=8),
            ),
        ],
    )
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    assert tree.nodes
    for node in tree.nodes:
        assert node.source_ref.page == 3  # the branch's real minimum page (blocks[0]'s own here)
        assert node.source_ref.page_end == 8  # widened to the branch's real maximum page, not blocks[0]'s


def test_widen_branch_page_range_finds_the_minimum_page_even_when_blocks_0_is_not_earliest() -> None:
    # Companion to the build_survey_tree-level test above, which (following
    # the plan's own worked example) happens to use an already-sorted
    # blocks[0]-is-earliest fixture -- that alone can't distinguish "real
    # min over all blocks" from "still just blocks[0]'s page" by coincidence.
    # This exercises _widen_branch_page_range directly with an OUT-OF-ORDER
    # page sequence to confirm the min is genuinely computed over every
    # block, not just inherited from whichever happens to be first.
    path = "survey_input.txt"
    representative = SourceRef(document_path=path, start_offset=0, end_offset=10, page=5, page_end=5)
    blocks = [
        Block(id="b0", kind=BlockKind.PARAGRAPH, text="first", source_ref=representative),
        Block(
            id="b1", kind=BlockKind.PARAGRAPH, text="second",
            source_ref=SourceRef(document_path=path, start_offset=10, end_offset=20, page=3, page_end=3),
        ),
        Block(
            id="b2", kind=BlockKind.PARAGRAPH, text="third",
            source_ref=SourceRef(document_path=path, start_offset=20, end_offset=30, page=8, page_end=8),
        ),
    ]
    widened = _widen_branch_page_range(representative, blocks, None, None)
    assert widened.page == 3  # real minimum across all blocks, not blocks[0]'s page=5
    assert widened.page_end == 8  # real maximum across all blocks


def test_build_survey_tree_llm_branch_attributes_an_uncaptioned_figure_positionally_and_stays_disjoint() -> None:
    # An uncaptioned figure's id is never rendered into section_text at all
    # (_render_block_line returns None for it), so the model can never name
    # it in figure_ids -- attributed instead via this branch's own
    # positional bracketing. Also proves the disjointness guarantee holds
    # even when the model HALLUCINATES the same id into figure_ids: it must
    # still be dropped there (not offered in this section, per
    # valid_figure_ids' own captioned-only restriction), never double-counted.
    path = "survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
        figures=[Figure(id="fig0", caption=None, source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[
            {
                "temp_id": "n0", "type": "Feature", "parent_temp_id": None,
                "title": "Display", "text": "The system shall handle: Display", "tags": [],
                "figure_ids": ["fig0"],  # hallucinated -- fig0 was never offered (uncaptioned)
            },
            {
                "temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0",
                "title": "HDR support", "text": "The system shall handle: HDR.", "tags": [],
            },
        ]
    )
    tree = build_survey_tree(doc, fake)
    all_figure_ids = [fid for n in tree.nodes for fid in n.figure_ids]
    all_uncaptioned_ids = [fid for n in tree.nodes for fid in n.uncaptioned_figure_ids]
    assert "fig0" not in all_figure_ids  # the hallucinated claim was dropped, never trusted
    assert all_uncaptioned_ids == ["fig0"]  # attributed exactly once, positionally
    assert set(all_figure_ids).isdisjoint(all_uncaptioned_ids)


def test_build_survey_tree_llm_branch_positional_attribution_also_populates_insignificant_figure_ids() -> None:
    # Task 4b sub-fix (ii), call site 5/5 (_build_survey_tree_for_branch's
    # own positional-bracketing fallback). fig0 (caption_status=
    # "insignificant") lands in both lists; fig1 (caption_status=
    # "vision_failed") lands in uncaptioned_figure_ids only.
    path = "survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
        figures=[
            Figure(id="fig0", caption=None, caption_status="insignificant", source_ref=_sr(path)),
            Figure(id="fig1", caption=None, caption_status="vision_failed", source_ref=_sr(path)),
        ],
    )
    fake = FakeSectionAnalysisClient(
        nodes=[
            {
                "temp_id": "n0", "type": "Feature", "parent_temp_id": None,
                "title": "Display", "text": "The system shall handle: Display", "tags": [],
            },
            {
                "temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0",
                "title": "HDR support", "text": "The system shall handle: HDR.", "tags": [],
            },
        ]
    )
    tree = build_survey_tree(doc, fake)
    all_uncaptioned_ids = [fid for n in tree.nodes for fid in n.uncaptioned_figure_ids]
    all_insignificant_ids = [fid for n in tree.nodes for fid in n.insignificant_figure_ids]
    assert set(all_uncaptioned_ids) == {"fig0", "fig1"}
    assert all_insignificant_ids == ["fig0"]
    assert set(all_insignificant_ids) <= set(all_uncaptioned_ids)


def test_build_survey_tree_multi_branch_path_also_populates_insignificant_figure_ids(monkeypatch) -> None:
    # Regression guard (review finding on commit 839532a): the multi-branch
    # loop's own _build_survey_tree_for_branch call site (build_survey_tree's
    # _run_branch, distinct from the single-call/whole-document call site the
    # test above exercises) never passed `figures=` at all -- only `tables=`
    # -- so on any document that actually splits into multiple branches,
    # insignificant_figure_ids silently stayed [] for every uncaptioned
    # figure, regardless of its real caption_status. The fix threads a
    # separate whole-document figure_caption_status_by_id map (mirroring
    # figure_id_by_block_id's own existing whole-document convention) to
    # BOTH call sites instead of widening the multi-branch site's `figures`
    # argument (which also feeds render_section/section labeling/source-ref
    # widening for that branch specifically, and must stay branch-scoped).
    #
    # fig0 sits in the SECOND branch ("Audio", non-first -- the exact case
    # the bug hid) via _two_branch_doc's own structure, extended with a
    # trailing FIGURE block.
    _force_multi_branch(monkeypatch)
    path = "two_branch_survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.HEADING, heading_level=1, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
            Block(id="b2", kind=BlockKind.HEADING, heading_level=1, text="Audio", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.PARAGRAPH, text="The speaker shall support 5.1 surround.", source_ref=_sr(path)),
            Block(id="b4", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
        figures=[Figure(id="fig0", caption=None, caption_status="insignificant", source_ref=_sr(path))],
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    assert len(fake.calls) == 2  # confirms the multi-branch path (not the single-call path) actually ran
    all_uncaptioned_ids = [fid for n in tree.nodes for fid in n.uncaptioned_figure_ids]
    all_insignificant_ids = [fid for n in tree.nodes for fid in n.insignificant_figure_ids]
    assert all_uncaptioned_ids == ["fig0"]
    assert all_insignificant_ids == ["fig0"]  # the field this bug left permanently empty on this path


def test_build_survey_tree_identity_and_fidelity_hashes_are_unaffected_by_section_path() -> None:
    # Whole-pipeline version of tree_builder.py's/id_tree_builder.py's own
    # identical invariant tests -- section_path is additive provenance
    # regardless of which of the four node-building paths populated it
    # (here: the deterministic heading-hierarchy path AND the LLM branch
    # path both contribute nodes to the same tree, via
    # test_build_survey_tree_merges_deterministic_and_llm_nodes_as_sibling_roots'
    # own hybrid-document pattern -- each path hashes identity differently,
    # see _hash_identity vs _hash_identity_for_synthesized_node's own
    # docstrings, but BOTH deliberately exclude section_path from their input).
    import hashlib

    from app.leveling.tree_builder import _hash_identity, _hash_identity_for_synthesized_node

    # Same hybrid-document pattern
    # test_build_survey_tree_merges_deterministic_and_llm_nodes_as_sibling_roots
    # uses -- residual content BEFORE the heading blocks stays outside every
    # span-claiming fold (which greedily claims everything trailing the LAST
    # claimed heading), guaranteeing this tree really does mix both a
    # deterministic (det0_...) and an LLM-branch (bare temp-id) node.
    path = "hybrid_survey_input.txt"
    residual = [
        Block(id="r0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
        Block(id="r1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.", source_ref=_sr(path)),
    ]
    doc = _structural_heading_doc().model_copy(update={"blocks": residual + _structural_heading_doc().blocks})
    tree = build_survey_tree(doc, FakeSectionAnalysisClient())
    det_root = next(n for n in tree.nodes if n.title == "System Domain")
    llm_root = next(n for n in tree.nodes if n.title == "Display")
    assert det_root.local_id.startswith("det")
    assert not llm_root.local_id.startswith("det")

    for node in tree.nodes:
        bare_ref = node.source_ref.model_copy(update={"section_path": []})
        assert node.fidelity_hash == hashlib.sha256(node.description.encode()).hexdigest()
        if node.local_id.startswith("det"):
            # Deterministic node -- identity is position-only, same as
            # every BASELINE node (see _hash_identity's own docstring).
            assert node.identity_hash == _hash_identity(node.description, bare_ref)
        else:
            # LLM branch node -- identity is keyed on local_id (see
            # _hash_identity_for_synthesized_node's own docstring), never on
            # the generated (wording-unstable) description text.
            assert node.identity_hash == _hash_identity_for_synthesized_node(node.local_id, bare_ref)


def test_build_survey_tree_never_calls_the_llm_for_a_pure_deterministic_document() -> None:
    class ExplodingClient:
        model = None

        def analyze_section(self, *a, **k):
            raise AssertionError("LLM analysis must not be called for a pure-deterministic doc")

        def analyze_section_agentic(self, *a, **k):
            raise AssertionError("LLM analysis must not be called for a pure-deterministic doc")

    tree = build_survey_tree(_structural_heading_doc(), ExplodingClient())
    assert len(tree.nodes) == 6
    # The det/LLM content-split informational message was removed (not
    # actionable, not a defect signal) -- ExplodingClient's own raise is
    # this test's real proof the LLM path was never invoked.


def test_build_survey_tree_merges_deterministic_and_llm_nodes_as_sibling_roots() -> None:
    # A hybrid document: the structural-heading subtree is fully
    # deterministic, but the residual paragraph blocks still need the LLM
    # path -- both must land as independent, un-nested roots. Distinct
    # block ids from _structural_heading_doc()'s own ("b0".."b5") --
    # real loaders never reuse ids across a document, and a collision
    # would wrongly filter the residual too (a real block's id doubling
    # as a claimed heading's id purely by fixture coincidence). Placed
    # BEFORE the heading blocks, not after: span-claiming greedily folds
    # every trailing non-heading block following the LAST claimed heading
    # (there being no further heading to bound the span) -- content
    # placed before the FIRST heading is the position guaranteed to stay
    # outside every span.
    path = "hybrid_survey_input.txt"
    residual = [
        Block(id="r0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
        Block(
            id="r1", kind=BlockKind.PARAGRAPH, text="The display shall support HDR.",
            source_ref=_sr(path),
        ),
    ]
    doc = _structural_heading_doc().model_copy(
        update={"blocks": residual + _structural_heading_doc().blocks}
    )
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    det_root = next(n for n in tree.nodes if n.title == "System Domain")
    llm_root = next(n for n in tree.nodes if n.title == "Display")
    assert det_root.parent_local_id is None
    assert llm_root.parent_local_id is None


def test_build_survey_tree_retrieves_kb_context_on_the_pure_deterministic_path() -> None:
    # Confirmed real gap: the pure-deterministic guard previously hardcoded
    # kb_context=None/kb_citations=[] for scoring unconditionally, even when
    # real user_id/embed_client/vector_store deps were supplied -- the org's
    # own KB grounding never applied to a deterministically-built document.
    # Same end-to-end pattern as
    # test_build_survey_tree_end_to_end_injects_real_ingested_kb_chunk
    # (real KbVectorStore, no monkeypatching), just against a pure-
    # deterministic document instead of an LLM-analyzed one.
    from app.kb.kb_vector_store import KbVectorStore

    store = KbVectorStore(persist_path="/tmp/unused-in-this-test-det-kb")
    store.upsert_chunk(
        chunk_id="source-1:spec.docx:0",
        embedding=[1.0, 0.0, 0.0],
        text="The system shall be reviewed against this reference material.",
        user_id="Project\\Area1",
        source_file="spec.docx",
        source_id="source-1",
        chunk_index=0,
        file_hash="hash-1",
    )

    class _FakeEmbedClient:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[1.0, 0.0, 0.0]]

    tree = build_survey_tree(
        _structural_heading_doc(),
        FakeSectionAnalysisClient(),
        user_id="Project\\Area1",
        embed_client=_FakeEmbedClient(),
        vector_store=store,
    )
    assert [c.source_file for c in tree.kb_citations] == ["spec.docx"]


def test_build_survey_tree_infers_trace_links_on_the_pure_deterministic_path() -> None:
    # Confirmed real gap: the pure-deterministic guard previously hardcoded
    # trace_links=[] unconditionally, even when a real link_type_client was
    # supplied -- a real cross-reference in the source text (e.g. "see
    # Requirement 282393") never resolved to an actual TraceLink. Whole-tree
    # trace-link inference must now run here exactly like the LLM-analysis
    # path. det0_h1_1 -> det0_h1_2 (two SIBLING leaves under the same root,
    # not a parent/child pair) -- deliberately not det0_h1 -> det0_h1_1
    # (root -> its own child), which the parent/child redundancy filter
    # below now correctly drops on its own merits.
    fake_client = FakeTraceLinkInferenceClient(
        results=[{"source_node_id": "det0_h1_1", "reference_name": "Rel", "target_ref": "det0_h1_2"}]
    )
    catalog = [{"reference_name": "Rel", "name": "Related", "semantic_hint": None}]
    tree = build_survey_tree(
        _structural_heading_doc(), FakeSectionAnalysisClient(),
        link_type_client=fake_client, link_type_catalog=catalog,
    )
    assert len(fake_client.calls) == 1
    assert any(link.source_local_id == "det0_h1_1" for link in tree.trace_links)


def test_build_survey_tree_is_a_true_no_op_when_nothing_qualifies() -> None:
    # A document matching none of the 3 conventions -- llm_doc must be the
    # exact same object as doc (a true no-op, not a copy), and no
    # provenance warning should fire.
    doc = _small_doc()
    fake = FakeSectionAnalysisClient()
    tree = build_survey_tree(doc, fake)
    assert tree.warnings == []


# ---------------------------------------------------------------------------
# _detect_conflicting_duplicates (near-duplicate clustering -> conflict
# detection) -- real capability gap: this codebase previously had NO
# conflict/contradiction detection anywhere.
# ---------------------------------------------------------------------------


class _FakeEmbedClientForConflicts:
    """Deterministic fake: returns a hand-picked embedding per text so
    cosine similarity is fully controlled by the test, not a real model."""

    def __init__(self, embedding_by_text: dict[str, list[float]]) -> None:
        self._embedding_by_text = embedding_by_text

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embedding_by_text[t] for t in texts]


class _FakeConflictClient:
    def __init__(self, verdict: dict) -> None:
        self._verdict = verdict
        self.calls: list[dict[str, str]] = []

    def judge_duplicate_cluster(self, texts_by_id: dict[str, str]) -> dict:
        self.calls.append(texts_by_id)
        return self._verdict


def test_detect_conflicting_duplicates_is_a_noop_without_both_clients() -> None:
    nodes = [_req_node("n0", "A"), _req_node("n1", "A")]
    warnings: list[str] = []
    verdict = {"verdict": "contradictory", "conflicting_values": []}
    _detect_conflicting_duplicates(nodes, None, _FakeConflictClient(verdict), warnings)
    embed_client = _FakeEmbedClientForConflicts({"A": [1.0]})
    _detect_conflicting_duplicates(nodes, embed_client, None, warnings)
    assert warnings == []
    assert nodes[0].quality_issues == []


def test_detect_conflicting_duplicates_flags_a_contradictory_cluster() -> None:
    text_a = "Power-supply efficiency shall be at least 85%."
    text_b = "Power-supply efficiency shall be at-least 93%."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0], text_b: [0.99, 0.01]})
    verdict = {"verdict": "contradictory", "conflicting_values": ["85%", "93%"]}
    conflict_client = _FakeConflictClient(verdict)
    warnings: list[str] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert len(conflict_client.calls) == 1
    assert set(conflict_client.calls[0].keys()) == {"n0", "n1"}
    assert any("conflicting values" in w.raw for w in warnings)
    for node in nodes:
        assert RequirementQualityIssue.CONFLICTING_VALUE in node.quality_issues
    # Confirmed real gap (user-reported): a bare local_id list means
    # nothing to a reviewer -- the real TITLE is all the prose carries now;
    # the structured `node_ids` field (not a text tag) is what the frontend
    # uses to build a real jump-to-node link.
    conflict_warning = next(w for w in warnings if "conflicting values" in w.raw)
    assert nodes[0].title in conflict_warning.raw
    assert nodes[1].title in conflict_warning.raw
    assert "localId" not in conflict_warning.raw
    assert conflict_warning.node_ids == ["n0", "n1"]


def test_detect_conflicting_duplicates_emits_progress_narration_before_the_llm_call() -> None:
    # Real gap this closes: previously this pass ran completely silently --
    # confirmed live, a multi-minute gap with zero narration between
    # scoring finishing and trace-link inference starting on a large
    # document, exactly where this embed+judge pass runs.
    text_a = "Power-supply efficiency shall be at least 85%."
    text_b = "Power-supply efficiency shall be at-least 93%."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0], text_b: [0.99, 0.01]})
    conflict_client = _FakeConflictClient({"verdict": "redundant", "conflicting_values": []})
    events: list[LevelingProgress] = []

    _detect_conflicting_duplicates(
        nodes, embed_client, conflict_client, [], events.append, 42, 7,
    )

    assert len(events) == 1
    assert events[0].phase == "detect_conflicts"
    assert events[0].blocks_total == 42
    assert events[0].branch_count == 7


def test_detect_conflicting_duplicates_emits_no_narration_when_it_is_a_noop() -> None:
    nodes = [_req_node("n0", "Only one candidate.")]
    events: list[LevelingProgress] = []

    _detect_conflicting_duplicates(nodes, None, None, [], events.append)

    assert events == []


def test_detect_conflicting_duplicates_leaves_a_redundant_cluster_untagged() -> None:
    text_a = "The system shall log every login attempt."
    text_b = "The system shall log every login attempt."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    # both nodes share the same text
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0]})
    conflict_client = _FakeConflictClient({"verdict": "redundant", "conflicting_values": []})
    warnings: list[str] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert len(conflict_client.calls) == 1
    assert warnings == []
    for node in nodes:
        assert RequirementQualityIssue.CONFLICTING_VALUE not in node.quality_issues


def test_detect_conflicting_duplicates_never_clusters_dissimilar_nodes() -> None:
    text_a = "The power supply shall accept 28VDC input."
    text_b = "The system shall support LDAP authentication."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0], text_b: [0.0, 1.0]})
    conflict_client = _FakeConflictClient({"verdict": "contradictory", "conflicting_values": []})
    warnings: list[str] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert conflict_client.calls == []  # never clustered -- orthogonal embeddings
    assert warnings == []


def test_detect_conflicting_duplicates_is_fail_open_on_embed_error() -> None:
    class RaisingEmbedClient:
        def embed(self, texts: list[str]) -> list[list[float]]:
            raise RuntimeError("boom")

    nodes = [_req_node("n0", "A"), _req_node("n1", "B")]
    warnings: list[str] = []
    conflict_client = _FakeConflictClient({"verdict": "contradictory", "conflicting_values": []})
    _detect_conflicting_duplicates(nodes, RaisingEmbedClient(), conflict_client, warnings)
    assert nodes[0].quality_issues == []


# ---------------------------------------------------------------------------
# _regroup_disconnected_roots (topical root regrouping) -- real gap:
# a document with no single top heading produces many disconnected root
# nodes, unlike a holistic LLM-authored hierarchy which naturally groups
# them under one coherent tree.
# ---------------------------------------------------------------------------


class _FakeGroupingClient:
    def __init__(self, result: dict) -> None:
        self._result = result
        self.calls: list[dict[str, str]] = []

    def group_root_topics(self, titles_by_id: dict[str, str]) -> dict:
        self.calls.append(titles_by_id)
        return self._result


def test_regroup_disconnected_roots_is_a_noop_without_a_client() -> None:
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    warnings: list[str] = []
    _regroup_disconnected_roots(nodes, "regroup_", None, warnings)
    assert nodes[0].parent_local_id is None
    assert nodes[1].parent_local_id is None
    assert warnings == []


def test_regroup_disconnected_roots_is_a_noop_with_fewer_than_two_roots() -> None:
    nodes = [_node("n0", WorkItemType.FEATURE, None, "Only Root")]
    client = _FakeGroupingClient({"groups": []})
    warnings: list[str] = []
    _regroup_disconnected_roots(nodes, "regroup_", client, warnings)
    assert client.calls == []


def test_regroup_disconnected_roots_emits_progress_narration_before_the_llm_call() -> None:
    # Real gap this closes: previously this pass (77 disconnected roots on a
    # real document) ran completely silently, indistinguishable from a
    # frozen/stalled job.
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    client = _FakeGroupingClient({"groups": []})
    events: list[LevelingProgress] = []

    _regroup_disconnected_roots(nodes, "regroup_", client, [], events.append, 99, 12)

    assert len(events) == 1
    assert events[0].phase == "regroup_roots"
    assert events[0].blocks_total == 99
    assert events[0].branch_count == 12


def test_regroup_disconnected_roots_emits_no_narration_when_it_is_a_noop() -> None:
    nodes = [_node("n0", WorkItemType.FEATURE, None, "Only Root")]
    events: list[LevelingProgress] = []

    _regroup_disconnected_roots(nodes, "regroup_", None, [], events.append)

    assert events == []


def test_regroup_disconnected_roots_groups_matching_roots_under_a_new_feature() -> None:
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
        _node("n2", WorkItemType.EPIC, None, "Unrelated Standalone Domain"),
    ]
    client = _FakeGroupingClient(
        {"groups": [{"title": "VPX Utility & Management Signals", "member_ids": ["n0", "n1"]}]}
    )
    warnings: list[str] = []

    _regroup_disconnected_roots(nodes, "regroup_", client, warnings)

    group_node = next(n for n in nodes if n.title == "VPX Utility & Management Signals")
    assert group_node.type == WorkItemType.FEATURE  # no Epic member -> Feature, not Epic
    assert group_node.parent_local_id is None  # the new group is itself a root
    assert group_node.local_id.startswith("regroup_synth_group_")
    n0 = next(n for n in nodes if n.local_id == "n0")
    n1 = next(n for n in nodes if n.local_id == "n1")
    n2 = next(n for n in nodes if n.local_id == "n2")
    assert n0.parent_local_id == group_node.local_id
    assert n1.parent_local_id == group_node.local_id
    assert n2.parent_local_id is None  # left untouched -- not mentioned in any group
    assert any("Grouped 2" in w.raw for w in warnings)


def test_regroup_disconnected_roots_uses_epic_type_when_any_member_is_an_epic() -> None:
    # CMMI validity: a Feature can never parent an Epic, so a group
    # containing an Epic-typed member must itself be an Epic.
    nodes = [
        _node("n0", WorkItemType.EPIC, None, "Domain A"),
        _node("n1", WorkItemType.FEATURE, None, "Domain B"),
    ]
    group_result = {"groups": [{"title": "Combined Domain", "member_ids": ["n0", "n1"]}]}
    client = _FakeGroupingClient(group_result)
    _regroup_disconnected_roots(nodes, "regroup_", client, [])
    group_node = next(n for n in nodes if n.title == "Combined Domain")
    assert group_node.type == WorkItemType.EPIC


def test_regroup_disconnected_roots_ignores_an_invented_member_id() -> None:
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    # "does-not-exist" is not a real root id -- the group should still form
    # from the two real ids, the invented one simply dropped.
    client = _FakeGroupingClient(
        {"groups": [{"title": "Group", "member_ids": ["n0", "n1", "does-not-exist"]}]}
    )
    _regroup_disconnected_roots(nodes, "regroup_", client, [])
    group_node = next(n for n in nodes if n.title == "Group")
    assert {n.parent_local_id for n in nodes if n.local_id in ("n0", "n1")} == {group_node.local_id}


def test_regroup_disconnected_roots_skips_a_single_member_group() -> None:
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    client = _FakeGroupingClient({"groups": [{"title": "Lonely Group", "member_ids": ["n0"]}]})
    _regroup_disconnected_roots(nodes, "regroup_", client, [])
    assert not any(n.title == "Lonely Group" for n in nodes)
    assert nodes[0].parent_local_id is None


def test_regroup_disconnected_roots_is_fail_open() -> None:
    class RaisingGroupingClient:
        def group_root_topics(self, titles_by_id: dict[str, str]) -> dict:
            raise RuntimeError("boom")

    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    warnings: list[str] = []
    _regroup_disconnected_roots(nodes, "regroup_", RaisingGroupingClient(), warnings)
    assert nodes[0].parent_local_id is None
    assert nodes[1].parent_local_id is None


# ---------------------------------------------------------------------------
# _ensure_root_features_have_epic_parent -- real gap (user-reported, live
# review): a mixed bag of Epic-typed and bare Feature-typed roots sitting
# as inconsistent siblings after topical regrouping.
# ---------------------------------------------------------------------------


def test_ensure_root_features_have_epic_parent_is_a_noop_with_no_epic_anywhere() -> None:
    # A document whose whole tree is uniformly Feature-topped (no Epic tier
    # at all) is a legitimate, already-tested shape -- must be left alone.
    nodes = [_node("n0", WorkItemType.FEATURE, None, "Lone Domain")]
    warnings: list[str] = []
    _ensure_root_features_have_epic_parent(nodes, "regroup_", warnings)
    assert nodes[0].parent_local_id is None
    assert warnings == []


def test_ensure_root_features_have_epic_parent_wraps_orphan_features_when_an_epic_exists() -> None:
    nodes = [
        _node("epic0", WorkItemType.EPIC, None, "Real Epic Domain"),
        _node("n0", WorkItemType.FEATURE, None, "Orphan Feature A"),
        _node("n1", WorkItemType.FEATURE, None, "Orphan Feature B"),
    ]
    warnings: list[str] = []
    _ensure_root_features_have_epic_parent(nodes, "regroup_", warnings)
    catch_all = next(n for n in nodes if n.local_id == "regroup_synth_root_epic")
    assert catch_all.type == WorkItemType.EPIC
    assert catch_all.parent_local_id is None
    n0 = next(n for n in nodes if n.local_id == "n0")
    n1 = next(n for n in nodes if n.local_id == "n1")
    epic0 = next(n for n in nodes if n.local_id == "epic0")
    assert n0.parent_local_id == catch_all.local_id
    assert n1.parent_local_id == catch_all.local_id
    assert epic0.parent_local_id is None  # a real root Epic is left untouched
    assert any("2 root Feature(s) had no Epic ancestor" in w.raw for w in warnings)


def test_ensure_root_features_have_epic_parent_is_a_noop_without_orphan_features() -> None:
    nodes = [_node("epic0", WorkItemType.EPIC, None, "Real Epic Domain")]
    warnings: list[str] = []
    _ensure_root_features_have_epic_parent(nodes, "regroup_", warnings)
    assert warnings == []
    assert not any(n.local_id == "regroup_synth_root_epic" for n in nodes)


# ---------------------------------------------------------------------------
# Primer context threading -- Phase 6a capability
# ---------------------------------------------------------------------------


def test_build_survey_tree_threads_primer_context_into_every_branch(monkeypatch) -> None:
    _force_multi_branch(monkeypatch)
    fake = FakeSectionAnalysisClient()
    build_survey_tree(_two_branch_doc(), fake, primer_context="This document specifies an avionics interface.")
    assert len(fake.calls) == 2
    for call in fake.calls:
        assert "This document specifies an avionics interface." in call["section_text"]


def test_build_survey_tree_defaults_primer_context_to_none_byte_identical() -> None:
    # None (the default) must be byte-identical to before this capability
    # existed -- same convention as every other optional *_client param.
    tree_without = build_survey_tree(_small_doc(), FakeSectionAnalysisClient())
    tree_with_none = build_survey_tree(_small_doc(), FakeSectionAnalysisClient(), primer_context=None)
    assert tree_without.nodes == tree_with_none.nodes
