
import pytest

from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    Document,
    DocumentFormat,
    Figure,
    SourceRef,
    Table,
    TableCell,
)
from app.job_cancel import JobCancelled
from app.leveling import llm_leveling as llm_leveling_module
from app.leveling.conflict_detection import _DUPLICATE_CLUSTER_COSINE_THRESHOLD, _cosine_similarity
from app.leveling.llm_leveling import (
    SurveyModelClient,
    _detect_conflicting_duplicates,
    _ensure_root_features_have_epic_parent,
    _regroup_disconnected_roots,
    _render_block_line,
    build_survey_tree,
    render_section,
)
from app.leveling.narration_publisher import LevelingProgress
from app.leveling.trace_links import _infer_trace_links_for_nodes
from app.workitem.model import (
    IntegrityWarning,
    KbCitationRelevance,
    RequirementQualityIssue,
    WarningKind,
    WorkItemMode,
    WorkItemNode,
    WorkItemType,
)


def _sr(path: str) -> SourceRef:
    return SourceRef(document_path=path, start_offset=0, end_offset=10)


def _node(
    local_id: str,
    node_type: WorkItemType,
    parent_local_id: str | None,
    title: str,
) -> WorkItemNode:
    """Minimal WorkItemNode builder for unit-testing the repair/matching
    functions directly, bypassing build_survey_tree -- used where the
    table-driven deterministic path (id_hierarchy/id_tree_builder) now
    claims any table that would otherwise reach these functions via the
    LLM path, making an end-to-end table fixture unable to exercise them
    any more (see each converted test's own docstring)."""
    ref = _sr("x.docx")
    return WorkItemNode(
        local_id=local_id,
        type=node_type,
        parent_local_id=parent_local_id,
        title=title,
        description=title,
        source_ref=ref,
        mode=WorkItemMode.SURVEY,
    )


def _req_node(local_id: str, description: str, title: str | None = None) -> WorkItemNode:
    # title defaults to the description's first 60 chars -- what all
    # pre-existing callers rely on. The explicit override exists for the
    # conflict-detection tests, where the whole point is a title that is NOT
    # a slice of the description (see _detect_conflicting_duplicates's
    # title/description blend).
    return WorkItemNode(
        local_id=local_id,
        type=WorkItemType.REQUIREMENT,
        parent_local_id=None,
        title=description[:60] if title is None else title,
        description=description,
        source_ref=_sr("x.docx"),
        mode=WorkItemMode.SURVEY,
    )


def _small_doc() -> CanonicalDoc:
    path = "survey_input.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(
                id="b1",
                kind=BlockKind.PARAGRAPH,
                text="The display shall support HDR.",
                source_ref=_sr(path),
            ),
        ],
    )


class FakeSurveyModelClient:
    """Test double for SurveyModelClient: the job's chat-model client, which never decides the structure (it comes from the
    document). It has none of the optional passes (no file-conventions pre-study, no sheet study), so the document's own structure is
    used as-is."""

    model = None


def test_build_survey_tree_defaults_customer_id_to_none_when_no_code_is_present() -> None:
    # Customer ID is a per-Requirement, document-derived attribute, never a
    # job-level value applied uniformly -- build_survey_tree has no
    # customer_id parameter at all. _author_branch_content DOES try to
    # extract a real customer-assigned code from each Requirement's final
    # description (see that function's own doc comment), but this fixture's
    # generated text has nothing code-shaped in it, so every node still
    # honestly gets None, across single- and multi-branch runs alike --
    # never fabricated just because none of _DEFAULT_NODES' text qualifies.
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    assert all(n.customer_id is None for n in tree.nodes)


def test_build_survey_tree_never_extracts_a_customer_code_from_plain_prose_alone() -> None:
    # Confirmed real bug, live (cubeadcs_icd.pdf): with no table folded in
    # at all, a code-shaped token in the model's own paraphrased prose
    # ("REQ-AV-014" here, "PC104"/"RS485" in the real document) is a cited
    # designator, not this node's own customer-assigned code, and must
    # stay honestly None.
    fake = FakeSurveyModelClient()
    tree = build_survey_tree(_small_doc(), fake)
    assert tree.nodes[0].customer_id is None


def _requirements_table(rows: list[list[str]], table_id: str = "t0", path: str = "x.docx") -> Table:
    return Table(
        id=table_id, cells=[[TableCell(text=c) for c in row] for row in rows], source_ref=_sr(path)
    )


def test_no_unclaimed_row_warning_when_every_identified_row_became_its_own_node() -> None:
    doc = CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="h"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.HEADING,
                heading_level=2,
                text="Synchronization",
                source_ref=_sr("x.docx"),
            )
        ],
        tables=[
            _requirements_table(
                [
                    ["#", "Parameter", "Requirement / Value"],
                    [
                        "P-SENSOR-001#",
                        "Time sync source",
                        "The system shall synchronize to Standard-XX within N ms.",
                    ],
                    [
                        "P-SENSOR-002#",
                        "Sync accuracy",
                        "Timing accuracy shall be better than X µs.",
                    ],
                ]
            )
        ],
    )
    fake = FakeSurveyModelClient()
    tree = build_survey_tree(doc, fake)
    assert not any(w.kind == WarningKind.MISSING_REQUIREMENT_ROW_COVERAGE for w in tree.warnings)


def test_build_survey_tree_has_no_warnings_when_node_count_matches_block_count() -> None:
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    assert tree.warnings == []


def test_build_survey_tree_does_not_warn_when_a_dropped_blocks_content_was_merged_elsewhere() -> (
    None
):
    # A block with no node of its own is NOT flagged as dropped if its
    # content still shows up (even paraphrased) in another node's generated
    # text -- a legitimate merge, not data loss.
    path = "merged.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text="The display shall support HDR playback.",
                source_ref=_sr(path),
            ),
            Block(
                id="b1",
                kind=BlockKind.PARAGRAPH,
                text="The receiver shall log all firmware errors.",
                source_ref=_sr(path),
            ),
        ],
    )
    fake = FakeSurveyModelClient()
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
            Block(
                id="b2",
                kind=BlockKind.PARAGRAPH,
                text="The unit shall boot within ten seconds.",
                source_ref=_sr(path),
            ),
        ],
    )
    fake = FakeSurveyModelClient()
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
            Block(
                id="b0",
                kind=BlockKind.PARAGRAPH,
                text="The unit shall boot within ten seconds.",
                source_ref=_sr(path),
            ),
            Block(id="b1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
    )
    fake = FakeSurveyModelClient()
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
                id="b0",
                kind=BlockKind.NOTE,
                text="[UNSUPPORTED: page 1 appears multi-column; extraction may misorder text]",
                source_ref=_sr(path),
            ),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(
                id="b2",
                kind=BlockKind.PARAGRAPH,
                text="The display shall support HDR.",
                source_ref=_sr(path),
            ),
        ],
    )
    fake = FakeSurveyModelClient()
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
                id="b0",
                kind=BlockKind.NOTE,
                text="[UNSUPPORTED: table extraction degraded structure (span/gap information lost) for a table on page 1]",
                source_ref=_sr(path),
            ),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text="Power Budget", source_ref=_sr(path)),
            Block(
                id="b2",
                kind=BlockKind.PARAGRAPH,
                text="The board shall draw no more than 3.3V.",
                source_ref=_sr(path),
            ),
        ],
    )
    fake = FakeSurveyModelClient()
    tree = build_survey_tree(doc, fake)

    assert len(tree.nodes) > 0
    for node in tree.nodes:
        assert not any("[UNSUPPORTED:" in part for part in node.source_ref.section_path)
        assert "[UNSUPPORTED:" not in node.description
    assert any(w.kind == WarningKind.UNSUPPORTED_CONTENT_NOTE for w in tree.warnings)


def test_survey_tree_nodes_have_survey_mode_and_real_fidelity_hash() -> None:
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    for node in tree.nodes:
        assert node.mode == WorkItemMode.SURVEY
        assert node.fidelity_hash is not None


def test_fidelity_hash_is_stable_across_identical_calls() -> None:
    tree_a = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    tree_b = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    hashes_a = [node.fidelity_hash for node in tree_a.nodes]
    hashes_b = [node.fidelity_hash for node in tree_b.nodes]
    assert hashes_a == hashes_b


def test_the_survey_model_client_protocol_asks_for_no_structure_call() -> None:
    # The structure comes from the document: the protocol has only the model name, and the fake satisfies it.
    client: SurveyModelClient = FakeSurveyModelClient()
    assert client.model is None
    assert [name for name in vars(SurveyModelClient) if not name.startswith("_")] == ["model"]


# ---------------------------------------------------------------------------
# Front-matter heading guard -- deterministic, zero-LLM-cost content filter
# ---------------------------------------------------------------------------


# --- [UNSUPPORTED: ...] diagnostic-note leak fix (pdf_loader.py's
# multi-column false-positive note must never leak as real content -- see
# _is_unsupported_content_note in tree_builder.py) ---


def test_render_block_line_omits_an_unsupported_content_note_block() -> None:
    path = "doc.txt"
    block = Block(
        id="b0",
        kind=BlockKind.NOTE,
        text="[UNSUPPORTED: page 7 appears multi-column]",
        source_ref=_sr(path),
    )
    assert _render_block_line(block) is None


# --- copyright/footer-boilerplate section-label leak fix (see
# _is_boilerplate_label_text in tree_builder.py) ---


def test_render_block_line_does_not_omit_a_note_block_without_the_unsupported_prefix() -> None:
    path = "deck.pptx"
    block = Block(
        id="b0", kind=BlockKind.NOTE, text="Speaker note: mention Q3 roadmap.", source_ref=_sr(path)
    )
    assert _render_block_line(block) == "Speaker note: mention Q3 roadmap."


def _table_with_group(
    rows: list[list[str]], path: str = "survey_input.txt", offset: int = 0
) -> Table:
    return Table(
        id="t0",
        cells=[[TableCell(text=c) for c in row] for row in rows],
        source_ref=SourceRef(document_path=path, start_offset=offset, end_offset=offset + 10),
    )


def test_build_survey_tree_fires_deterministic_subtree_progress_for_a_qualifying_table() -> None:
    # Real gap this closes: _detect_deterministic_subtrees ran immediately
    # after preparing_analysis with zero narration of its own -- confirmed
    # live as a genuine 20+ minute silent window on a document with many
    # ID-hierarchy table rows.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group(
                    [
                        ["Requirement ID", "Requirement / Section"],
                        ["1.1", "External Source Detection"],
                        ["1.1.1", "The system shall detect X."],
                        ["1.1.2", "The system shall detect Y."],
                    ]
                )
            ]
        }
    )
    events: list = []
    build_survey_tree(
        doc, FakeSurveyModelClient(), progress_callback=lambda p: events.append(p)
    )

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 1
    assert subtree_events[0].subtree_index == 0
    assert subtree_events[0].subtree_count == 1
    assert subtree_events[0].subtree_label == "Table t0"


def test_build_survey_tree_fires_deterministic_subtree_progress_for_a_structural_heading_document() -> (
    None
):
    events: list = []
    build_survey_tree(
        _structural_heading_doc(),
        FakeSurveyModelClient(),
        progress_callback=lambda p: events.append(p),
    )

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 1
    assert subtree_events[0].subtree_index == 0
    assert subtree_events[0].subtree_count == 1
    assert subtree_events[0].subtree_label == "Heading hierarchy"


def test_build_survey_tree_reports_the_real_subtree_count_across_multiple_qualifying_subtrees() -> (
    None
):
    # One qualifying table AND a structural-heading residual -- both
    # subtrees must be counted in subtree_count from the very first event,
    # not just however many have been seen so far.
    doc = _structural_heading_doc().model_copy(
        update={
            "tables": [
                _table_with_group(
                    [
                        ["Requirement ID", "Requirement / Section"],
                        ["1.1", "External Source Detection"],
                        ["1.1.1", "The system shall detect X."],
                        ["1.1.2", "The system shall detect Y."],
                    ]
                )
            ]
        }
    )
    events: list = []
    build_survey_tree(
        doc, FakeSurveyModelClient(), progress_callback=lambda p: events.append(p)
    )

    subtree_events = [e for e in events if e.phase == "deterministic_subtree"]
    assert len(subtree_events) == 2
    assert [e.subtree_count for e in subtree_events] == [2, 2]
    assert [e.subtree_index for e in subtree_events] == [0, 1]
    assert subtree_events[0].subtree_label == "Table t0"
    assert subtree_events[1].subtree_label == "Heading hierarchy"


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
                _table_with_group(
                    [
                        ["Requirement ID", "Requirement / Section"],
                        ["1.1", "External Source Detection"],
                        ["1.1.1", "The system shall detect X."],
                        ["1.1.2", "The system shall detect Y."],
                    ]
                )
            ]
        }
    )
    fake = FakeSurveyModelClient()
    tree = build_survey_tree(doc, fake)
    assert any(n.title == "External Source Detection" for n in tree.nodes)
    assert not any("did not produce a distinctly-titled node" in w.raw for w in tree.warnings)


def test_build_survey_tree_does_not_warn_when_a_qualifying_group_did_become_a_node() -> None:
    # Positive control: the coverage check must NOT fire just because a
    # table group exists -- only when no node's title reflects it.
    doc = _small_doc().model_copy(
        update={
            "tables": [
                _table_with_group(
                    [
                        ["Requirement ID", "Requirement / Section"],
                        ["1.1", "External Source Detection"],
                        ["1.1.1", "The system shall detect X."],
                        ["1.1.2", "The system shall detect Y."],
                    ]
                )
            ]
        }
    )
    fake = FakeSurveyModelClient()
    tree = build_survey_tree(doc, fake)
    assert not any("did not produce a distinctly-titled node" in w.raw for w in tree.warnings)


def test_build_survey_tree_forwards_chunk_concurrency_to_the_deterministic_passes(
    monkeypatch,
) -> None:
    # Proves the parameter is actually THREADED, not merely accepted and
    # dropped -- the failure mode a signature-only change would leave behind.
    import app.leveling.id_tree_builder as id_tree_builder_module

    seen: list[int] = []
    original = id_tree_builder_module._apply_title_tag_pass

    def spy(*args, **kwargs):
        seen.append(kwargs.get("chunk_concurrency", 1))
        return original(*args, **kwargs)

    monkeypatch.setattr(id_tree_builder_module, "_apply_title_tag_pass", spy)

    class TitleTagClient:
        def title_and_tags_for_rows(self, texts_by_row_id, user_id=None):
            return {node_id: {"title": "T", "tags": []} for node_id in texts_by_row_id}

    build_survey_tree(
        _structural_heading_doc(),
        FakeSurveyModelClient(),
        title_tag_client=TitleTagClient(),
        chunk_concurrency=7,
    )

    assert seen and all(value == 7 for value in seen)


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
        user_id: str | None = None,
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
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    for node in tree.nodes:
        assert node.quality_score is None
        assert node.quality_issues == []


def test_build_survey_tree_requirement_scoring_failure_fires_chunk_warning() -> None:
    # docs/ui-progress-review.md item #3: this failure must be visible LIVE
    # (via progress_callback), not just in the final tree.warnings list.
    class _RaisingRequirementScoringClient(FakeScoringClient):
        def score_requirements_for_document(
            self,
            descriptions_by_node_id,
            criteria_context=None,
            kb_context=None,
            category_checklist=None,
            user_id=None, together=False,
        ):
            raise ValueError("boom")

    fired: list[LevelingProgress] = []
    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        _RaisingRequirementScoringClient(),
        progress_callback=fired.append,
    )

    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert any(chunk_warnings[0].warning_message == w.raw for w in tree.warnings)


def test_apply_quality_scores_missing_score_fires_chunk_warning() -> None:
    from app.leveling.scoring import _apply_quality_scores

    class _EmptyScoringClient:
        def score_requirements_for_document(
            self,
            descriptions_by_node_id,
            criteria_context=None,
            kb_context=None,
            category_checklist=None,
            user_id=None, together=False,
        ):
            return {}  # every node comes back with no valid score

    nodes = [_req_node("n1", "The system shall do x.")]
    warnings: list[str] = []
    fired: list[LevelingProgress] = []

    _apply_quality_scores(
        nodes, _EmptyScoringClient(), warnings, "", progress_callback=fired.append
    )

    assert "returned no valid score" in warnings[0].raw
    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert chunk_warnings[0].warning_message == warnings[0].raw


def test_apply_quality_scores_inconsistent_categories_fires_chunk_warning() -> None:
    from app.leveling.scoring import _apply_quality_scores

    class _InconsistentCategoriesClient:
        def score_requirements_for_document(
            self,
            descriptions_by_node_id,
            criteria_context=None,
            kb_context=None,
            category_checklist=None,
            user_id=None, together=False,
        ):
            return {
                "n1": {"score": 80, "issues": [], "categoryScores": {"clarity": 80}},
                "n2": {"score": 70, "issues": [], "categoryScores": {"rationale": 70}},
            }

    nodes = [_req_node("n1", "The system shall do x."), _req_node("n2", "The system shall do y.")]
    warnings: list[str] = []
    fired: list[LevelingProgress] = []

    _apply_quality_scores(
        nodes, _InconsistentCategoriesClient(), warnings, "", progress_callback=fired.append
    )

    assert any("2 different sets of category names" in w.raw for w in warnings)
    chunk_warnings = [p for p in fired if p.phase == "chunk_warning"]
    assert len(chunk_warnings) == 1
    assert "2 different sets of category names" in chunk_warnings[0].warning_message


def test_build_survey_tree_passes_none_criteria_context_when_no_retriever_is_supplied() -> None:
    # Backward-compat: criteria_retriever is entirely optional, same as
    # scoring_client -- omitted must be byte-identical to before this
    # capability existed (score_requirements_for_document sees
    # criteria_context=None).
    scoring_client = FakeScoringClient()
    build_survey_tree(_small_doc(), FakeSurveyModelClient(), scoring_client)
    assert scoring_client.criteria_contexts == [None]


def test_build_survey_tree_grounds_scoring_with_retrieved_criteria_when_a_retriever_is_supplied() -> (
    None
):
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
        FakeSurveyModelClient(),
        scoring_client,
        criteria_retriever=retriever,
    )

    assert len(retriever.queries) == 1  # one retrieve() call per branch, not per node
    assert scoring_client.criteria_contexts[0] is not None
    assert CRITERIA_CORPUS[0].text in scoring_client.criteria_contexts[0]


def test_build_survey_tree_falls_back_to_none_for_a_missing_or_malformed_score_and_warns() -> None:
    # Tolerant of LLM non-compliance: a missing/malformed entry for one
    # node must not crash the batch or affect sibling nodes.
    scoring_client = FakeScoringClient(
        results={
            "n0": {"score": 150, "issues": []},  # out of 0-100 range
            # "n1" missing entirely
        }
    )
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient(), scoring_client)

    for node in tree.nodes:
        assert node.quality_score is None
    assert any("no valid score" in w.raw for w in tree.warnings)


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
        FakeSurveyModelClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert call_count["n"] == 1


def _kb_hit(source_file: str, similarity: float, text: str) -> dict:
    distance = 1 - similarity
    return {
        "source_file": source_file,
        "distance": distance,
        "similarity": similarity,
        "text": text,
    }


def _stub_kb_documents(monkeypatch, names: list[str]) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(KbVectorStore, "list_documents", lambda self, user_id: list(names))


def test_build_survey_tree_kb_coverage_counts_zero_cited_when_kb_has_files(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    _stub_kb_documents(monkeypatch, ["a.pdf", "b.pdf"])
    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", lambda *a, **k: (None, []))
    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_coverage is not None
    assert (tree.kb_coverage.files_available, tree.kb_coverage.files_cited) == (2, 0)


def test_build_survey_tree_kb_coverage_is_none_without_kb_deps() -> None:
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    assert tree.kb_coverage is None


def test_build_survey_tree_score_requirements_events_carry_the_real_kb_citations_not_an_empty_list(
    monkeypatch,
) -> None:
    # Confirmed real user-reported bug: score_requirements/score_requirements_done
    # previously hardcoded kb_citations_raw=[] regardless of kb_grounded, so a
    # genuinely KB-grounded scoring pass rendered "grounded with 0 KB file(s)"
    # in narration -- a contradiction (kb_grounded=True, 0 citations) that reads
    # as "not really using the KB" even though scoring's own kb_context WAS
    # built from real query_kb hits. Must carry the same real per-file
    # citation list section_complete already correctly reports.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [
            {
                "source_file": "agentic.docx",
                "distance": 0.1,
                "similarity": 0.9,
                "text": "agentic KB text",
            }
        ]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    class _FakeScoringClient:
        def score_requirements_for_document(
            self,
            descriptions_by_node_id,
            criteria_context=None,
            kb_context=None,
            category_checklist=None,
            user_id=None, together=False,
        ):
            return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}

    fake = FakeSurveyModelClient()
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


def test_build_survey_tree_scoring_uses_the_stored_checklist_from_the_grounding_document(
    tmp_path, monkeypatch
) -> None:
    # Confirmed real determinism requirement (user-reported): the SAME
    # document run any number of times must yield the SAME categories --
    # this is the fix: reads the checklist extracted ONCE at KB ingestion
    # time (stored via KbVectorStore.upsert_chunk) for whichever grounding
    # document contributed this scoring pass, instead of ever letting the
    # scoring LLM derive categories live.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [
            {
                "source_file": "standard.pdf",
                "distance": 0.1,
                "similarity": 0.9,
                "text": "agentic KB text",
            }
        ]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    vector_store.upsert_chunk(
        chunk_id="s1:standard.pdf:0",
        embedding=[1.0, 0.0, 0.0],
        text="checklist text",
        user_id="Project\\Area1",
        source_file="standard.pdf",
        source_id="s1",
        chunk_index=0,
        file_hash="h1",
        quality_checklist=["Necessary", "Unambiguous", "Verifiable"],
    )

    captured: dict = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(
            self,
            descriptions_by_node_id,
            criteria_context=None,
            kb_context=None,
            category_checklist=None,
            user_id=None, together=False,
        ):
            captured["category_checklist"] = category_checklist
            return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}

    fake = FakeSurveyModelClient()
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


def test_build_survey_tree_falls_back_to_none_checklist_when_grounding_document_never_had_one_extracted(
    tmp_path, monkeypatch
) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "agentic KB text", [
            {
                "source_file": "old_doc.pdf",
                "distance": 0.1,
                "similarity": 0.9,
                "text": "agentic KB text",
            }
        ]

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    vector_store = KbVectorStore(persist_path=str(tmp_path))
    # Ingested WITHOUT a checklist_client -- pre-dates this capability.
    vector_store.upsert_chunk(
        chunk_id="s1:old_doc.pdf:0",
        embedding=[1.0, 0.0, 0.0],
        text="some text",
        user_id="Project\\Area1",
        source_file="old_doc.pdf",
        source_id="s1",
        chunk_index=0,
        file_hash="h1",
    )

    captured: dict = {}

    class _CapturingScoringClient:
        def score_requirements_for_document(
            self,
            descriptions_by_node_id,
            criteria_context=None,
            kb_context=None,
            category_checklist=None,
            user_id=None, together=False,
        ):
            captured["category_checklist"] = category_checklist
            return {node_id: {"score": 90, "issues": []} for node_id in descriptions_by_node_id}

    fake = FakeSurveyModelClient()
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
        self._response = response or {
            "context_length": 64_000,
            "capabilities": ["completion", "tools"],
        }
        self._raises = raises
        self.call_count = 0

    def show_model(self, model: str, user_id: str | None = None) -> dict:
        self.call_count += 1
        if self._raises:
            raise RuntimeError("orchestrator unreachable")
        return self._response


def test_resolve_caps_unknown_model_uses_live_lookup_when_caps_client_supplied() -> None:
    from app.leveling.model_caps import _resolve_caps

    fake_client = _FakeCapsClient(
        {"context_length": 64_000, "capabilities": ["completion", "tools"]}
    )
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

    fake_client = _FakeCapsClient(
        {"context_length": 200_000, "capabilities": ["completion", "tools"]}
    )
    caps = _resolve_caps("some-huge-model-v9", caps_client=fake_client)

    assert caps.context_budget_tokens == 200_000
    assert (
        caps.coverage_budget_tokens == caps.context_budget_tokens
    )  # no lost-in-the-middle guard at this scale
    assert caps.branch_cap == 100_000


def test_resolve_caps_live_lookup_below_frontier_threshold_keeps_conservative_local_defaults() -> (
    None
):
    from app.leveling.model_caps import (
        _COVERAGE_BUDGET_TOKENS,
        _MAX_SURVEY_BRANCH_BLOCK_COUNT,
        _resolve_caps,
    )

    fake_client = _FakeCapsClient(
        {"context_length": 32_000, "capabilities": ["completion", "tools"]}
    )
    caps = _resolve_caps("some-modest-model-v9", caps_client=fake_client)

    assert caps.context_budget_tokens == 32_000
    assert (
        caps.coverage_budget_tokens == _COVERAGE_BUDGET_TOKENS
    )  # the lost-in-the-middle guard stays on
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

    fake_client = _FakeCapsClient(
        {"context_length": 1, "capabilities": []}
    )  # would produce very different caps
    caps = _resolve_caps("qwen3.6:35b", caps_client=fake_client)

    assert caps.coverage_budget_tokens == 20_000  # the real static-table value, untouched
    assert fake_client.call_count == 0


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
            user_id: str | None = None,
        ) -> dict[str, dict]:
            captured["scoring_kb_context"] = kb_context
            return {node_id: {"score": 100, "issues": []} for node_id in descriptions_by_node_id}

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [
                {
                    "source_file": "doc-a.docx",
                    "distance": 0.1,
                    "similarity": 0.9,
                    "text": "injected KB text",
                }
            ],
        ),
    )

    build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        scoring_client=_CapturingScoringClient(),
    )
    assert captured["scoring_kb_context"] == "injected KB text"


def test_build_survey_tree_without_area_path_has_empty_kb_citations() -> None:
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    assert tree.kb_citations == []


def test_build_survey_tree_threads_kb_citations_from_retrieve_context(monkeypatch) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [
                {
                    "source_file": "doc-a.docx",
                    "distance": 0.1,
                    "similarity": 0.9,
                    "text": "chunk a",
                },
                {"source_file": "doc-b.pdf", "distance": 0.2, "similarity": 0.8, "text": "chunk b"},
            ],
        ),
    )

    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
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
        FakeSurveyModelClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations == []


def test_build_survey_tree_kb_citations_stay_unknown_relevance_when_no_relevance_client(
    monkeypatch,
) -> None:
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
        FakeSurveyModelClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )
    assert tree.kb_citations[0].relevance == KbCitationRelevance.UNKNOWN


def test_build_survey_tree_kb_citations_get_verified_relevance_when_relevance_client_supplied(
    monkeypatch,
) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [
                {
                    "source_file": "relevant.docx",
                    "distance": 0.1,
                    "similarity": 0.9,
                    "text": "chunk a",
                },
                {
                    "source_file": "irrelevant.docx",
                    "distance": 0.2,
                    "similarity": 0.8,
                    "text": "chunk b",
                },
            ],
        ),
    )

    class _FakeKbRelevanceClient:
        def judge_kb_relevance(
            self, branch_content: str, snippets: list[dict], user_id: str | None = None
        ) -> dict[str, str]:
            return {"0": "relevant", "1": "not_relevant"}

    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        kb_relevance_client=_FakeKbRelevanceClient(),
    )
    by_file = {c.source_file: c.relevance for c in tree.kb_citations}
    assert by_file["relevant.docx"] == KbCitationRelevance.RELEVANT
    assert by_file["irrelevant.docx"] == KbCitationRelevance.NOT_RELEVANT


def test_build_survey_tree_kb_citations_degrade_to_unknown_when_relevance_client_raises(
    monkeypatch,
) -> None:
    from app.kb.kb_vector_store import KbVectorStore

    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda user_id, query_text, embed_client, vector_store, **_: (
            "injected KB text",
            [{"source_file": "doc-a.docx", "distance": 0.1, "similarity": 0.9, "text": "chunk a"}],
        ),
    )

    class _RaisingKbRelevanceClient:
        def judge_kb_relevance(
            self, branch_content: str, snippets: list[dict], user_id: str | None = None
        ) -> dict[str, str]:
            raise RuntimeError("orchestrator unreachable")

    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
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

    def infer_trace_links(
        self,
        nodes: list[dict],
        link_type_catalog: list[dict],
        kb_context: str | None = None,
        user_id: str | None = None,
    ) -> list[dict]:
        self.calls.append(
            {"nodes": nodes, "link_type_catalog": link_type_catalog, "kb_context": kb_context}
        )
        return self._results


def test_infer_trace_links_for_nodes_drops_a_link_whose_evidence_quote_is_not_in_the_source_node_text() -> (
    None
):
    # Real anti-hallucination guard (SWEEP.md section 7): a proposed link
    # whose evidence_quote isn't a literal substring of the SOURCE node's
    # own text has no verifiable textual basis and must be dropped, same
    # fail-open-per-entry philosophy as every other check in this loop.
    nodes = [
        _req_node("n0", "The system shall support HDR."),
        _req_node("n1", "The customer requires high dynamic range video."),
    ]
    client = FakeTraceLinkInferenceClient(
        results=[
            {
                "source_node_id": "n0",
                "reference_name": "Affects",
                "target_ref": "n1",
                "evidence_quote": "text that does not appear anywhere in n0",
            }
        ]
    )
    warnings: list = []
    links = _infer_trace_links_for_nodes(nodes, client, [], warnings, None, 0, 0)
    assert links == []


def test_infer_trace_links_for_nodes_drops_a_link_whose_evidence_quote_is_not_a_string() -> None:
    # M2: the schema's `evidence_quote` field is only best-effort-enforced
    # (a schema-rejecting Ollama version degrades to a schema-less retry --
    # see the stale-prompt fix this shares its root cause with), so the
    # model can return a non-string evidence_quote (e.g. a list) despite
    # the schema. `x not in <str>` on a non-string `x` raises TypeError,
    # which nothing in the surrounding per-link loop catches -- this must
    # be rejected via the same fail-open-per-entry path as every other
    # malformed-link case, not propagate and abort the whole call.
    nodes = [
        _req_node("n0", "The system shall support HDR."),
        _req_node("n1", "The customer requires high dynamic range video."),
    ]
    client = FakeTraceLinkInferenceClient(
        results=[
            {
                "source_node_id": "n0",
                "reference_name": "Affects",
                "target_ref": "n1",
                "evidence_quote": ["not", "a", "string"],
            }
        ]
    )
    warnings: list = []
    links = _infer_trace_links_for_nodes(nodes, client, [], warnings, None, 0, 0)
    assert links == []


def test_build_survey_tree_without_link_type_client_leaves_trace_links_empty() -> None:
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    assert tree.trace_links == []


def test_build_survey_tree_sends_trace_link_nodes_without_a_redundant_title_key() -> None:
    # title duplicated description's content for no signal (the model
    # references node_id, not title, in its output) -- dropped to save
    # tokens. text must NOT be truncated (a separate, deliberate
    # non-change) since external ref ids can appear anywhere in it.
    fake_client = FakeTraceLinkInferenceClient()
    build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        link_type_client=fake_client,
        link_type_catalog=[],
    )
    assert len(fake_client.calls) == 1
    for node in fake_client.calls[0]["nodes"]:
        assert set(node.keys()) == {"node_id", "type", "text"}


def test_build_survey_tree_sends_trace_link_nodes_with_table_html_stripped() -> None:
    # Real, root-caused bug (confirmed live, cubeadcs_icd.pdf): re-embedding
    # a deterministic node's folded table HTML into its description (the
    # parent-summary content-preservation fix) more-than-tripled the total
    # payload size of this whole-tree call for a document with many
    # deterministic-subtree tables, degrading the model's own JSON output
    # into a malformed non-object entry that crashed the job. Table HTML
    # carries no cross-reference signal -- it must never reach this
    # specific payload, even though it's correctly still embedded in the
    # tree's own persisted node.description.
    path = "structural_survey_input.txt"

    def sr(offset: int) -> SourceRef:
        return SourceRef(document_path=path, start_offset=offset, end_offset=offset + 10)

    def h(block_id: str, level: int, text: str, offset: int) -> Block:
        return Block(
            id=block_id,
            kind=BlockKind.HEADING,
            heading_level=level,
            text=text,
            source_ref=sr(offset),
        )

    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            h("b0", 1, "System Domain", 0),
            h("b1", 2, "The system shall do A.", 100),
            h("b2", 2, "The system shall do B.", 200),
            h("b3", 2, "The system shall do C.", 300),
            h("b4", 2, "The system shall do D.", 400),
            h("b5", 2, "The system shall do E.", 500),
        ],
        tables=[
            Table(
                id="t0",
                cells=[[TableCell(text=c) for c in row] for row in [["Rail", "Voltage"]]],
                source_ref=sr(50),
            ),
        ],
    )

    class FakeParentSummaryClient:
        def summarize_parent_nodes(self, nodes_by_id, user_id=None):
            return {
                node_id: {"title": "Synthesized Epic", "description": "Covers A-E."}
                for node_id in nodes_by_id
            }

    fake_trace_client = FakeTraceLinkInferenceClient()
    tree = build_survey_tree(
        doc,
        FakeSurveyModelClient(),
        parent_summary_client=FakeParentSummaryClient(),
        link_type_client=fake_trace_client,
        link_type_catalog=[],
    )

    epic = next(n for n in tree.nodes if n.title == "Synthesized Epic")
    assert "<table>" in epic.description  # the actual fix: still embedded in the real tree

    assert len(fake_trace_client.calls) == 1
    sent = next(n for n in fake_trace_client.calls[0]["nodes"] if n["node_id"] == epic.local_id)
    assert "<table" not in sent["text"]
    assert "Covers A-E." in sent["text"]  # real prose survives the strip


def test_build_survey_tree_calls_infer_trace_links_exactly_once_with_the_catalog() -> None:
    fake_client = FakeTraceLinkInferenceClient()
    catalog = [
        {"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}
    ]
    build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        link_type_client=fake_client,
        link_type_catalog=catalog,
    )
    assert len(fake_client.calls) == 1
    assert fake_client.calls[0]["link_type_catalog"] == catalog


def test_build_survey_tree_forwards_doc_kb_context_to_trace_link_inference_on_fallback_path(
    monkeypatch,
) -> None:
    # Task 6: relationship EXISTENCE between two nodes is still judged from
    # node text alone (unchanged), but the link-TYPE-CHOICE for an ambiguous
    # custom type can benefit from the document's own KB material -- the
    # SAME doc_kb_context every other LLM call in build_survey_tree reuses
    # must now reach infer_trace_links too, on the fallback (non-agentic)
    # path where it is actually populated.
    from app.kb.kb_vector_store import KbVectorStore

    def _fake_retrieve_context(user_id, query_text, embed_client, vector_store, **_):
        return "org traceability conventions doc text", []

    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", _fake_retrieve_context)

    fake_client = FakeTraceLinkInferenceClient()
    catalog = [
        {"reference_name": "Elisra.CoveredBy-Forward", "name": "Covered By", "semantic_hint": None}
    ]
    build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        model="some-unknown-model",  # _resolve_caps gating: forces the fallback (non-agentic) path
        link_type_client=fake_client,
        link_type_catalog=catalog,
    )
    assert len(fake_client.calls) == 1
    assert fake_client.calls[0]["kb_context"] == "org traceability conventions doc text"


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
    catalog = [
        {
            "reference_name": "Microsoft.VSTS.Common.Affects-Forward",
            "name": "Affects",
            "semantic_hint": None,
        }
    ]
    fake_client = FakeTraceLinkInferenceClient(
        results=[
            {
                "source_node_id": "n0",
                "reference_name": "Microsoft.VSTS.Common.Affects-Forward",
                "target_ref": "n1",
                "evidence_quote": "Display",
            },
            {
                "source_node_id": "n1",
                "reference_name": "Microsoft.VSTS.Common.Affects-Forward",
                "target_ref": "n0",
                "evidence_quote": "support HDR",
            },
        ]
    )
    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        link_type_client=fake_client,
        link_type_catalog=catalog,
    )
    assert tree.trace_links == []


def test_build_survey_tree_drops_a_self_referencing_trace_link() -> None:
    catalog = [
        {
            "reference_name": "Microsoft.VSTS.Common.Affects-Forward",
            "name": "Affects",
            "semantic_hint": None,
        }
    ]
    fake_client = FakeTraceLinkInferenceClient(
        results=[
            {
                "source_node_id": "n1",
                "reference_name": "Microsoft.VSTS.Common.Affects-Forward",
                "target_ref": "n1",
                "evidence_quote": "support HDR",
            }
        ]
    )
    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        link_type_client=fake_client,
        link_type_catalog=catalog,
    )
    assert tree.trace_links == []


def _trace_nodes(count: int) -> list[WorkItemNode]:
    return [
        _req_node(f"n{i}", f"Requirement number {i} shall do thing {i} per REQ-9.")
        for i in range(count)
    ]


class _ChunkRecordingTraceClient:
    """Records each call's node ids; raises a 502 for any call that includes a node in `poison`."""

    def __init__(self, poison: set[str] | None = None, links: list[dict] | None = None) -> None:
        self.calls: list[list[str]] = []
        self._poison = poison or set()
        self._links = links

    def infer_trace_links(self, nodes, link_type_catalog, kb_context=None, user_id=None):
        ids = [n["node_id"] for n in nodes]
        self.calls.append(ids)
        if self._poison & set(ids):
            import httpx

            raise httpx.HTTPStatusError(
                "502",
                request=httpx.Request("POST", "http://x"),
                response=httpx.Response(502),
            )
        return (
            [
                {
                    "source_node_id": ids[0],
                    "target_ref": "REQ-9",
                    "reference_name": "System.LinkTypes.Related",
                    "evidence_quote": "per REQ-9",
                }
            ]
            if self._links is None
            else self._links
        )


def test_trace_links_are_requested_in_bounded_chunks() -> None:
    from app.leveling import trace_links as tl

    nodes = _trace_nodes(tl._TRACE_CHUNK_MAX_NODES * 2 + 1)
    client = _ChunkRecordingTraceClient()

    links = _infer_trace_links_for_nodes(nodes, client, [], [], None, 0, 0)

    assert [len(c) for c in client.calls] == [
        tl._TRACE_CHUNK_MAX_NODES,
        tl._TRACE_CHUNK_MAX_NODES,
        1,
    ]
    assert len(links) == 3  # every chunk's link is merged


def test_trace_link_chunks_also_respect_the_request_size() -> None:
    from app.leveling import trace_links as tl

    big = "x" * (tl._TRACE_CHUNK_MAX_CHARS // 2 + 1)
    nodes = [_req_node(f"n{i}", big) for i in range(3)]
    client = _ChunkRecordingTraceClient(links=[])

    _infer_trace_links_for_nodes(nodes, client, [], [], None, 0, 0)

    assert [len(c) for c in client.calls] == [1, 1, 1]


def test_a_failed_trace_link_chunk_is_retried_as_halves_and_the_rest_is_kept() -> None:
    from app.leveling import trace_links as tl
    from app.workitem.model import WarningKind

    nodes = _trace_nodes(tl._TRACE_CHUNK_MAX_NODES + 4)
    client = _ChunkRecordingTraceClient(poison={"n0"})
    warnings: list = []

    links = _infer_trace_links_for_nodes(nodes, client, [], warnings, None, 0, 0)

    # chunk 1 failed whole, then as two halves; the half without n0 answered, the half with n0 was skipped;
    # chunk 2 answered.
    half = tl._TRACE_CHUNK_MAX_NODES // 2
    assert [len(c) for c in client.calls] == [tl._TRACE_CHUNK_MAX_NODES, half, half, 4]
    assert len(links) == 2
    partial = [w for w in warnings if w.kind == WarningKind.TRACE_LINKS_PARTIAL]
    assert len(partial) == 1 and len(partial[0].node_ids) == half and "n0" in partial[0].node_ids
    assert not any(w.kind == WarningKind.TRACE_LINK_INFERENCE_FAILED for w in warnings)


def test_trace_links_never_raise_when_every_call_fails_with_an_http_error() -> None:
    from app.workitem.model import WarningKind

    nodes = _trace_nodes(3)
    client = _ChunkRecordingTraceClient(poison={"n0", "n1", "n2"})
    warnings: list = []

    links = _infer_trace_links_for_nodes(nodes, client, [], warnings, None, 0, 0)

    assert links == []
    assert [w.kind for w in warnings] == [WarningKind.TRACE_LINK_INFERENCE_FAILED]


def test_build_survey_tree_captures_the_raw_response_when_trace_link_inference_fails() -> None:
    class _RaisingTraceLinkClient:
        def infer_trace_links(self, nodes, link_type_catalog, kb_context=None, user_id=None):
            raise ValueError("malformed JSON in LLM response content: 'Based'")

    class _FakeDebugCapture:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, str]] = []

        def capture(self, kind: str, identifier: str, raw_response: str) -> None:
            self.calls.append((kind, identifier, raw_response))

    debug_capture = _FakeDebugCapture()
    build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        link_type_client=_RaisingTraceLinkClient(),
        link_type_catalog=[],
        debug_capture=debug_capture,
    )
    assert len(debug_capture.calls) == 1
    kind, identifier, raw_response = debug_capture.calls[0]
    assert kind == "infer_trace_links"
    assert identifier == "document"
    assert "malformed JSON in LLM response content: 'Based'" in raw_response


def test_build_survey_tree_drops_a_link_whose_source_node_id_does_not_exist() -> None:
    fake_client = FakeTraceLinkInferenceClient(
        results=[
            {
                "source_node_id": "does-not-exist",
                "target_ref": "n0",
                "reference_name": "System.LinkTypes.Related",
                "evidence_quote": "Display",
            }
        ]
    )
    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        link_type_client=fake_client,
        link_type_catalog=[{"reference_name": "System.LinkTypes.Related", "name": "Related"}],
    )
    assert tree.trace_links == []


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
    block = Block(
        id="b5", kind=BlockKind.FIGURE, text="[FIGURE: A power schematic]", source_ref=_sr(path)
    )
    text = render_section([block], figure_id_by_block_id={"b5": "f3"})
    assert "> Figure f3: A power schematic" in text


def test_render_section_omits_the_figure_id_when_no_map_is_supplied() -> None:
    # None is byte-identical to before figure_id_by_block_id existed --
    # _figure_line/block.text (shared with BASELINE) are never touched.
    path = "x.docx"
    block = Block(
        id="b5", kind=BlockKind.FIGURE, text="[FIGURE: A power schematic]", source_ref=_sr(path)
    )
    text = render_section([block])
    assert "> Figure: A power schematic" in text
    assert "f3" not in text


def test_render_section_prefixes_each_table_with_its_own_id_marker() -> None:
    # Unlike figures, no id map is needed here -- table.id is already
    # directly available from the `tables` list itself.
    path = "x.docx"
    table = Table(
        id="t2",
        cells=[[TableCell(text=c) for c in row] for row in [["h1", "h2"], ["a", "b"]]],
        source_ref=_sr(path),
    )
    text = render_section([], tables=[table])
    assert "[TABLE t2]" in text
    assert text.index("[TABLE t2]") < text.index("| h1 | h2 |")


# --- STAGE 2 seam: figure/table mapping ------------------------------------
# Deciding WHICH figures/tables belong to which node is a whole-document
# mapping pass that runs BETWEEN skeleton generation and content authoring
# (_map_figures_tables_to_nodes -- see the "STAGE 2" section further down for
# that pass's own end-to-end tests). The tests here exercise the SEAM it
# feeds: they run the FULL build_survey_tree pipeline and inject verdicts
# directly at the very call site the pass supplies them from, so the
# validation/table-HTML-embedding machinery is pinned independently of how a
# verdict was reached.


def _table_doc(cells: list[list[str]]) -> CanonicalDoc:
    path = "table_only.txt"
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        tables=[
            Table(
                id="t0",
                cells=[[TableCell(text=c) for c in row] for row in cells],
                source_ref=_sr(path),
            )
        ],
    )


def test_build_survey_tree_does_not_warn_on_a_section_with_no_attachment_references() -> None:
    tree = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    assert not any("did not ingest" in w.raw for w in tree.warnings)


# Coverage-safe chunking (§1/§2 of the AirPro under-synthesis fix): a document
# can fit comfortably inside a model's real context window while still being
# too large to safely analyze in ONE holistic call (lost-in-the-middle
# positional bias) -- these tests use REAL text sizes against gemma4:e4b's
# real caps (context 90_000 tokens, coverage 10_000 tokens), not the
# `_force_multi_branch` monkeypatch (which reports an impossibly large size
# regardless of real budget logic) -- they exercise the actual gate/merge.


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
        return Block(
            id=block_id,
            kind=BlockKind.HEADING,
            heading_level=level,
            text=text,
            source_ref=_sr(path),
        )

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
    doc = (
        _structural_heading_doc()
    )  # Epic "System Domain" -> 5 Requirement leaves, deterministic end to end

    class FakeParentSummaryAndCapsClient:
        def __init__(self, context_length: int) -> None:
            self.context_length = context_length
            self.summarize_calls: list[dict] = []
            self.show_model_calls: list[str] = []

        def show_model(self, model: str, user_id: str | None = None) -> dict:
            self.show_model_calls.append(model)
            return {"context_length": self.context_length, "capabilities": ["completion"]}

        def summarize_parent_nodes(self, nodes_by_id: dict, user_id: str | None = None) -> dict:
            self.summarize_calls.append(nodes_by_id)
            return {
                node_id: {"title": "Synthesized Epic", "description": "Covers A-E."}
                for node_id in nodes_by_id
            }

    fake_client = FakeParentSummaryAndCapsClient(context_length=32_000)
    tree = build_survey_tree(
        doc,
        FakeSurveyModelClient(),
        parent_summary_client=fake_client,
        model="some-fresh-model-v9-parent-summary",
    )

    assert fake_client.show_model_calls == [
        "some-fresh-model-v9-parent-summary"
    ]  # live lookup actually happened
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

        def show_model(self, model: str, user_id: str | None = None) -> dict:
            self.show_model_calls.append(model)
            return {"context_length": 1, "capabilities": []}

        def summarize_parent_nodes(self, nodes_by_id: dict, user_id: str | None = None) -> dict:
            return {
                node_id: {"title": "Synthesized Epic", "description": "Covers A-E."}
                for node_id in nodes_by_id
            }

    fake_client = FakeParentSummaryAndCapsClient()
    build_survey_tree(
        doc, FakeSurveyModelClient(), parent_summary_client=fake_client, model="qwen3.6:35b"
    )

    assert fake_client.show_model_calls == []


def test_build_survey_tree_never_folds_a_figure_caption_into_the_deterministic_description() -> (
    None
):
    # A real caption must never leak into a deterministic node's description
    # -- neither as the raw wire-format placeholder ("[FIGURE: {caption or
    # 'none'}]") NOR as a formatted "> Figure: ..." line. The Figures UI
    # section (NodeDetailPanel.tsx) already renders the thumbnail + caption
    # independently of this text, via figure_ids alone -- embedding the
    # caption again in the description was pure duplication (removed per
    # explicit user request).
    path = "structural_survey_input.txt"
    doc = _structural_heading_doc().model_copy(
        update={
            "blocks": [
                *_structural_heading_doc().blocks,
                Block(
                    id="fig0",
                    kind=BlockKind.FIGURE,
                    text="[FIGURE: a wiring diagram of the power supply]",
                    source_ref=_sr(path),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert "wiring diagram" not in last_leaf.description
    assert "[FIGURE:" not in last_leaf.description  # raw wire format never leaks through either


def test_build_survey_tree_parent_summary_preserves_a_deterministically_claimed_table() -> None:
    # Real, root-caused bug (confirmed live against a real SURVEY job,
    # cubeadcs_icd.pdf): a table claimed into a deterministic Epic/Feature's
    # span via _detect_deterministic_subtrees' heading-span-claiming loop
    # has its HTML embedded in `description` BEFORE _apply_det_parent_summary
    # runs -- that pass replaces the whole description with a fresh
    # synthesized summary, and without preserving the already-embedded
    # table HTML, table_ids keeps pointing at content nowhere in the
    # description (a "Table tN" chip with zero content).
    #
    # Real (spread, not identical) source offsets are required here, not
    # _structural_heading_doc()'s all-identical (0,10) shortcut -- the
    # span-claiming boundary search resolves a tie to the LAST heading in
    # the document (confirmed empirically), which would attach the table
    # to the last Requirement leaf instead of the Feature/Epic this test
    # needs to exercise. Positioning the table's offset between the
    # Feature heading's own offset and its first child's offset is what
    # actually claims it at the Feature level.
    path = "structural_survey_input.txt"

    def sr(offset: int) -> SourceRef:
        return SourceRef(document_path=path, start_offset=offset, end_offset=offset + 10)

    def h(block_id: str, level: int, text: str, offset: int) -> Block:
        return Block(
            id=block_id,
            kind=BlockKind.HEADING,
            heading_level=level,
            text=text,
            source_ref=sr(offset),
        )

    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            h("b0", 1, "System Domain", 0),
            h("b1", 2, "The system shall do A.", 100),
            h("b2", 2, "The system shall do B.", 200),
            h("b3", 2, "The system shall do C.", 300),
            h("b4", 2, "The system shall do D.", 400),
            h("b5", 2, "The system shall do E.", 500),
        ],
        tables=[
            Table(
                id="t0",
                cells=[[TableCell(text=c) for c in row] for row in [["Rail", "Voltage"]]],
                source_ref=sr(50),
            ),
        ],
    )

    class FakeParentSummaryClient:
        def summarize_parent_nodes(self, nodes_by_id, user_id=None):
            return {
                node_id: {"title": "Synthesized Epic", "description": "Covers A-E."}
                for node_id in nodes_by_id
            }

    tree = build_survey_tree(
        doc, FakeSurveyModelClient(), parent_summary_client=FakeParentSummaryClient()
    )
    epic = next(n for n in tree.nodes if n.title == "Synthesized Epic")
    assert "t0" in epic.table_ids
    assert "Covers A-E." in epic.description
    assert "<table>" in epic.description
    assert "Rail" in epic.description and "Voltage" in epic.description


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
                    id="fig0",
                    kind=BlockKind.FIGURE,
                    text="[FIGURE: none]",
                    source_ref=_sr(path),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
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
    tree = build_survey_tree(doc, FakeSurveyModelClient())

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
        b.model_copy(
            update={"source_ref": b.source_ref.model_copy(update={"page": 1, "page_end": 1})}
        )
        for b in base_doc.blocks
    ]
    trailing_block = Block(
        id="trail0",
        kind=BlockKind.PARAGRAPH,
        text="Additional clarifying detail for requirement E.",
        source_ref=SourceRef(document_path=path, start_offset=0, end_offset=10, page=3, page_end=3),
    )
    doc = base_doc.model_copy(update={"blocks": [*paged_blocks, trailing_block]})
    tree = build_survey_tree(doc, FakeSurveyModelClient())
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
                    document_path=path,
                    start_offset=i * 10,
                    end_offset=i * 10 + 9,
                    page=1,
                    page_end=1,
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
                    id="t0",
                    cells=[
                        [TableCell(text=c) for c in row]
                        for row in [["Note", "See appendix for full rationale."]]
                    ],
                    source_ref=SourceRef(
                        document_path=path, start_offset=999, end_offset=1000, page=4, page_end=4
                    ),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
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
                    document_path=path,
                    start_offset=i * 10,
                    end_offset=i * 10 + 9,
                    page=1,
                    page_end=1,
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
                    id="t0",
                    cells=[[TableCell(text=""), TableCell(text="")]],
                    source_ref=SourceRef(
                        document_path=path, start_offset=999, end_offset=1000, page=4, page_end=4
                    ),
                ),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.table_ids == []
    assert "<table>" not in last_leaf.description
    assert "t0" not in last_leaf.description
    warning = next(w for w in tree.warnings if w.kind == WarningKind.EMPTY_TABLE_CONTENT)
    assert warning.node_ids == [last_leaf.local_id]
    assert warning.detail["tableId"] == "t0"


# --- section_path / figure_ids / table_ids / uncaptioned_figure_ids (Phase 2) ---


def test_build_survey_tree_deterministic_span_fold_records_figure_ids_and_uncaptioned_figure_ids() -> (
    None
):
    # Companion to the two "folds/drops a figure caption deterministically"
    # tests above -- those only prove the DESCRIPTION text; this proves the
    # id lists a real Figure now attributes to the span-claiming target.
    path = "structural_survey_input.txt"
    doc = _structural_heading_doc().model_copy(
        update={
            "blocks": [
                *_structural_heading_doc().blocks,
                Block(
                    id="fig0",
                    kind=BlockKind.FIGURE,
                    text="[FIGURE: a wiring diagram]",
                    source_ref=_sr(path),
                ),
                Block(
                    id="fig1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)
                ),
            ],
            "figures": [
                Figure(id="f0", caption="a wiring diagram", source_ref=_sr(path)),
                Figure(id="f1", caption=None, source_ref=_sr(path)),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.figure_ids == ["f0"]
    assert last_leaf.uncaptioned_figure_ids == ["f1"]
    assert set(last_leaf.figure_ids).isdisjoint(last_leaf.uncaptioned_figure_ids)


def test_build_survey_tree_deterministic_span_fold_populates_insignificant_figure_ids_as_a_subset() -> (
    None
):
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
                Block(
                    id="fig1", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)
                ),
                Block(
                    id="fig2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)
                ),
            ],
            "figures": [
                Figure(id="f1", caption=None, caption_status="insignificant", source_ref=_sr(path)),
                Figure(id="f2", caption=None, caption_status="vision_failed", source_ref=_sr(path)),
            ],
        }
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
    last_leaf = next(n for n in tree.nodes if n.title == "The system shall do E.")
    assert last_leaf.uncaptioned_figure_ids == ["f1", "f2"]
    assert last_leaf.insignificant_figure_ids == ["f1"]


def test_build_survey_tree_structural_heading_subtree_sets_section_path() -> None:
    tree = build_survey_tree(_structural_heading_doc(), FakeSurveyModelClient())
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
                _table_with_group(
                    [
                        ["Requirement ID", "Requirement / Section"],
                        ["1.1", "External Source Detection"],
                        ["1.1.1", "The system shall detect X."],
                        ["1.1.2", "The system shall detect Y."],
                    ]
                )
            ]
        }
    )
    tree = build_survey_tree(doc, FakeSurveyModelClient())
    group_node = next(n for n in tree.nodes if n.title == "External Source Detection")
    leaf = next(n for n in tree.nodes if n.title == "The system shall detect X.")
    assert group_node.table_ids == ["t0"]
    assert leaf.table_ids == ["t0"]
    assert group_node.source_ref.section_path == ["Table t0"]
    assert leaf.source_ref.section_path == ["Table t0", "External Source Detection"]


def test_build_survey_tree_llm_branch_attributes_an_uncaptioned_figure_positionally_and_stays_disjoint() -> (
    None
):
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
            Block(
                id="b0",
                kind=BlockKind.HEADING,
                heading_level=1,
                text="Display",
                source_ref=_sr(path),
            ),
            Block(
                id="b1",
                kind=BlockKind.PARAGRAPH,
                text="The display shall support HDR.",
                source_ref=_sr(path),
            ),
            Block(id="b2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
        figures=[Figure(id="fig0", caption=None, source_ref=_sr(path))],
    )
    fake = FakeSurveyModelClient()
    tree = build_survey_tree(doc, fake)
    all_figure_ids = [fid for n in tree.nodes for fid in n.figure_ids]
    all_uncaptioned_ids = [fid for n in tree.nodes for fid in n.uncaptioned_figure_ids]
    assert "fig0" not in all_figure_ids  # the hallucinated claim was dropped, never trusted
    assert all_uncaptioned_ids == ["fig0"]  # attributed exactly once, positionally
    assert set(all_figure_ids).isdisjoint(all_uncaptioned_ids)


def test_build_survey_tree_llm_branch_positional_attribution_also_populates_insignificant_figure_ids() -> (
    None
):
    # Task 4b sub-fix (ii), call site 5/5 (_build_survey_skeleton_for_branch's
    # own positional-bracketing fallback). fig0 (caption_status=
    # "insignificant") lands in both lists; fig1 (caption_status=
    # "vision_failed") lands in uncaptioned_figure_ids only.
    path = "survey_input.txt"
    doc = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(
                id="b0",
                kind=BlockKind.HEADING,
                heading_level=1,
                text="Display",
                source_ref=_sr(path),
            ),
            Block(
                id="b1",
                kind=BlockKind.PARAGRAPH,
                text="The display shall support HDR.",
                source_ref=_sr(path),
            ),
            Block(id="b2", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
            Block(id="b3", kind=BlockKind.FIGURE, text="[FIGURE: none]", source_ref=_sr(path)),
        ],
        figures=[
            Figure(id="fig0", caption=None, caption_status="insignificant", source_ref=_sr(path)),
            Figure(id="fig1", caption=None, caption_status="vision_failed", source_ref=_sr(path)),
        ],
    )
    fake = FakeSurveyModelClient()
    tree = build_survey_tree(doc, fake)
    all_uncaptioned_ids = [fid for n in tree.nodes for fid in n.uncaptioned_figure_ids]
    all_insignificant_ids = [fid for n in tree.nodes for fid in n.insignificant_figure_ids]
    assert set(all_uncaptioned_ids) == {"fig0", "fig1"}
    assert all_insignificant_ids == ["fig0"]
    assert set(all_insignificant_ids) <= set(all_uncaptioned_ids)


def test_build_survey_tree_never_calls_the_llm_for_a_pure_deterministic_document() -> None:
    class ExplodingClient:
        model = None

        def analyze_section(self, *a, **k):
            raise AssertionError("LLM analysis must not be called for a pure-deterministic doc")

        def analyze_section_agentic(self, *a, **k):
            raise AssertionError("LLM analysis must not be called for a pure-deterministic doc")

    tree = build_survey_tree(_structural_heading_doc(), ExplodingClient())
    # The document's six items, plus the Epic the ladder adds above a top-level section that had none.
    assert len([n for n in tree.nodes if "synth_" not in n.local_id]) == 6
    # The det/LLM content-split informational message was removed (not
    # actionable, not a defect signal) -- ExplodingClient's own raise is
    # this test's real proof the LLM path was never invoked.


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
        def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
            return [[1.0, 0.0, 0.0]]

    tree = build_survey_tree(
        _structural_heading_doc(),
        FakeSurveyModelClient(),
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
        results=[
            {
                "source_node_id": "det0_h1_1",
                "reference_name": "Rel",
                "target_ref": "det0_h1_2",
                "evidence_quote": "The system shall do B",
            }
        ]
    )
    catalog = [{"reference_name": "Rel", "name": "Related", "semantic_hint": None}]
    doc = _structural_heading_doc()
    doc.blocks[1] = doc.blocks[1].model_copy(
        update={"text": "The system shall do A per The system shall do B."}
    )
    tree = build_survey_tree(
        doc,
        FakeSurveyModelClient(),
        link_type_client=fake_client,
        link_type_catalog=catalog,
    )
    assert len(fake_client.calls) == 1
    assert any(link.source_local_id == "det0_h1_1" for link in tree.trace_links)


def test_build_survey_tree_is_a_true_no_op_when_nothing_qualifies() -> None:
    # A document matching none of the 3 conventions -- llm_doc must be the
    # exact same object as doc (a true no-op, not a copy), and no
    # provenance warning should fire.
    doc = _small_doc()
    fake = FakeSurveyModelClient()
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
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self._embedding_by_text[t] for t in texts]


class _FakeConflictClient:
    """Answers every pair alike: `same` for same_parameter, `agree` for values_agree."""

    def __init__(self, same: str = "yes", agree: str = "yes") -> None:
        self._answer = {"same_parameter": same, "values_agree": agree}
        self.calls: list[dict[str, dict[str, str]]] = []

    def judge_parameter_pairs(
        self, pairs_by_id: dict[str, dict[str, str]], user_id: str | None = None
    ) -> dict[str, dict]:
        self.calls.append(pairs_by_id)
        return {pair_id: dict(self._answer) for pair_id in pairs_by_id}


def test_detect_conflicting_duplicates_is_a_noop_without_both_clients() -> None:
    nodes = [_req_node("n0", "A"), _req_node("n1", "A")]
    warnings: list[str] = []
    _detect_conflicting_duplicates(nodes, None, _FakeConflictClient("yes", "no"), warnings)
    embed_client = _FakeEmbedClientForConflicts({"A": [1.0]})
    _detect_conflicting_duplicates(nodes, embed_client, None, warnings)
    assert warnings == []
    assert nodes[0].quality_issues == []


def test_detect_conflicting_duplicates_flags_a_contradictory_cluster() -> None:
    text_a = "Power-supply efficiency shall be at least 85%."
    text_b = "Power-supply efficiency shall be at-least 93%."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0], text_b: [0.99, 0.01]})
    conflict_client = _FakeConflictClient("yes")
    warnings: list[str] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert len(conflict_client.calls) == 1
    assert list(conflict_client.calls[0].values()) == [{"a": text_a, "b": text_b}]
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
    # The values come from code, as each text states them, not from the model.
    assert conflict_warning.detail == {"conflictingValues": ["85%", "93%"]}


def test_detect_conflicting_duplicates_emits_progress_narration_before_the_llm_call() -> None:
    # Real gap this closes: previously this pass ran completely silently --
    # confirmed live, a multi-minute gap with zero narration between
    # scoring finishing and trace-link inference starting on a large
    # document, exactly where this embed+judge pass runs.
    text_a = "Power-supply efficiency shall be at least 85%."
    text_b = "Power-supply efficiency shall be at-least 93%."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0], text_b: [0.99, 0.01]})
    conflict_client = _FakeConflictClient("no")
    events: list[LevelingProgress] = []

    _detect_conflicting_duplicates(
        nodes,
        embed_client,
        conflict_client,
        [],
        events.append,
        42,
        7,
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


class _FlakyConflictClient:
    """Fails whenever a call holds more than `max_ok` pairs (or always when max_ok is None)."""

    def __init__(self, max_ok: int | None) -> None:
        self._max_ok = max_ok
        self.calls: list[int] = []

    def judge_parameter_pairs(
        self, pairs_by_id: dict[str, dict[str, str]], user_id: str | None = None
    ) -> dict[str, dict]:
        self.calls.append(len(pairs_by_id))
        if self._max_ok is None or len(pairs_by_id) > self._max_ok:
            raise RuntimeError("400 schema rejected")
        return {pair_id: {"same_parameter": "no", "values_agree": "yes"} for pair_id in pairs_by_id}


def _four_near_duplicates() -> tuple[list, _FakeEmbedClientForConflicts]:
    texts = [f"Efficiency shall be at least {v}%." for v in (85, 86, 87, 88)]
    nodes = [_req_node(f"n{i}", t) for i, t in enumerate(texts)]
    embed = _FakeEmbedClientForConflicts({t: [1.0, 0.001 * i] for i, t in enumerate(texts)})
    return nodes, embed


def test_conflict_judgment_failure_is_retried_split_and_succeeds_without_a_warning() -> None:
    nodes, embed = _four_near_duplicates()
    client = _FlakyConflictClient(max_ok=3)
    warnings: list = []

    _detect_conflicting_duplicates(nodes, embed, client, warnings)

    assert client.calls == [6, 3, 3]  # four nodes whose values all differ: six pairs, then halves
    assert warnings == []


def test_conflict_judgment_that_still_fails_emits_one_warning_with_the_node_ids() -> None:
    from app.workitem.model import WarningKind

    nodes, embed = _four_near_duplicates()
    client = _FlakyConflictClient(max_ok=None)
    warnings: list = []

    _detect_conflicting_duplicates(nodes, embed, client, warnings)

    skipped = [w for w in warnings if w.kind == WarningKind.CONFLICT_JUDGMENT_SKIPPED]
    assert sorted(i for w in skipped for i in w.node_ids) == ["n0", "n1", "n2", "n3"]
    assert all("schema rejected" in w.detail["reason"] for w in skipped)


def test_small_cluster_is_asked_once_more_then_reported() -> None:
    from app.workitem.model import WarningKind

    nodes, embed = _four_near_duplicates()
    nodes, embed = nodes[:2], embed
    client = _FlakyConflictClient(max_ok=None)
    warnings: list = []

    _detect_conflicting_duplicates(nodes, embed, client, warnings)

    assert client.calls == [1, 1]
    assert [w.kind for w in warnings] == [WarningKind.CONFLICT_JUDGMENT_SKIPPED]
    assert warnings[0].node_ids == ["n0", "n1"]


def test_detect_conflicting_duplicates_leaves_a_redundant_cluster_untagged() -> None:
    text_a = "The system shall log every login attempt."
    text_b = "The system shall log every login attempt."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    # both nodes share the same text
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0]})
    conflict_client = _FakeConflictClient("yes", "no")
    warnings: list[str] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert conflict_client.calls == []  # the same text cannot conflict with itself: code settles it, no call
    assert warnings == []
    for node in nodes:
        assert RequirementQualityIssue.CONFLICTING_VALUE not in node.quality_issues


def test_detect_conflicting_duplicates_never_clusters_dissimilar_nodes() -> None:
    text_a = "The power supply shall accept 28VDC input."
    text_b = "The system shall support LDAP authentication."
    nodes = [_req_node("n0", text_a), _req_node("n1", text_b)]
    embed_client = _FakeEmbedClientForConflicts({text_a: [1.0, 0.0], text_b: [0.0, 1.0]})
    conflict_client = _FakeConflictClient("yes", "no")
    warnings: list[str] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert conflict_client.calls == []  # never clustered -- orthogonal embeddings
    assert warnings == []


def test_detect_conflicting_duplicates_is_fail_open_on_embed_error() -> None:
    class RaisingEmbedClient:
        def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
            raise RuntimeError("boom")

    nodes = [_req_node("n0", "A"), _req_node("n1", "B")]
    warnings: list[str] = []
    conflict_client = _FakeConflictClient("yes", "no")
    _detect_conflicting_duplicates(nodes, RaisingEmbedClient(), conflict_client, warnings)
    assert nodes[0].quality_issues == []


def test_detect_conflicting_duplicates_clusters_a_terse_fragment_with_its_formal_restatement() -> (
    None
):
    # Confirmed live bug this locks in: a spec table's terse fragment and the
    # body's full formal sentence state the SAME parameter with CONTRADICTING
    # values, but description-alone embedding measured only 0.65 against the
    # real embed model -- under the 0.85 clustering threshold, so the pair
    # never reached conflict_client at all (the 85%/93% efficiency pair
    # measured 0.80, also under). Length and register dominate a small
    # general-purpose sentence embedding; the nodes' TITLES are what leveling
    # already normalized, so the title+description blend carries the pair over.
    title = "Power Supply Input Voltage"
    text_a = "Input 28VAC"
    text_b = "The power supply shall accept an input of 28V DC from the platform."
    nodes = [_req_node("n0", text_a, title=title), _req_node("n1", text_b, title=title)]
    # Unit vectors chosen so description-alone cosine is exactly 0.65 (the
    # measured real-model value) while the shared title sits on their
    # bisector (cosine 0.9083 to each) -- blending each description 50/50
    # with that title lands the pair at 0.9083, over threshold.
    embed_client = _FakeEmbedClientForConflicts(
        {
            title: [0.9083, 0.4183],
            text_a: [1.0, 0.0],
            text_b: [0.65, 0.7599],
        }
    )
    # Pins the "previously would NOT have been detected" half of this test:
    # if the descriptions alone ever clear the threshold, this test has
    # stopped proving anything.
    assert _cosine_similarity([1.0, 0.0], [0.65, 0.7599]) < _DUPLICATE_CLUSTER_COSINE_THRESHOLD
    conflict_client = _FakeConflictClient("yes")
    warnings: list[IntegrityWarning] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert embed_client.calls == [[title, title, text_a, text_b]]
    assert len(conflict_client.calls) == 1
    assert list(conflict_client.calls[0].values()) == [{"a": text_a, "b": text_b}]
    assert any("conflicting values" in w.raw for w in warnings)
    assert [w.detail for w in warnings] == [{"conflictingValues": ["28VAC", "28V DC"]}]
    for node in nodes:
        assert RequirementQualityIssue.CONFLICTING_VALUE in node.quality_issues


def test_detect_conflicting_duplicates_clusters_correctly_at_scale_vectorized_vs_pairwise() -> None:
    # Regression for the O(n^2) pure-Python -> vectorized-matmul rewrite:
    # proves the matrix-based similarity computation produces the IDENTICAL
    # union-find clustering the old per-pair _cosine_similarity loop did,
    # not just for a hand-picked 2-node case (the tests above) but across
    # enough nodes that a real indexing mistake in the matrix rewrite (e.g.
    # a transposed axis, an off-by-one in the upper-triangle loop) would
    # show up as nodes clustering with the wrong group or not at all.
    #
    # Group A (10 nodes) and Group C (5 nodes) sit at cosine 0.9 to each
    # other (over the 0.85 threshold) and must merge into ONE 15-node
    # cluster. Group B (15 nodes) is orthogonal to both (cosine 0.0) and
    # must never merge with them -- proving the matrix correctly keeps
    # dissimilar rows/columns apart, not just correctly merges similar ones.
    vec_a = [1.0, 0.0]
    vec_b = [0.0, 1.0]
    vec_c = [0.9, (1 - 0.9**2) ** 0.5]  # cosine 0.9 to vec_a
    assert _cosine_similarity(vec_a, vec_c) >= _DUPLICATE_CLUSTER_COSINE_THRESHOLD
    assert _cosine_similarity(vec_a, vec_b) < _DUPLICATE_CLUSTER_COSINE_THRESHOLD

    nodes = []
    embedding_by_text: dict[str, list[float]] = {}
    for i in range(10):
        text = f"Group A statement {i}"
        embedding_by_text[text] = vec_a
        nodes.append(_req_node(f"a{i}", text, title=text))
    for i in range(15):
        text = f"Group B statement {i}"
        embedding_by_text[text] = vec_b
        nodes.append(_req_node(f"b{i}", text, title=text))
    for i in range(5):
        text = f"Group C statement {i}"
        embedding_by_text[text] = vec_c
        nodes.append(_req_node(f"c{i}", text, title=text))

    embed_client = _FakeEmbedClientForConflicts(embedding_by_text)
    conflict_client = _FakeConflictClient("no")
    warnings: list[IntegrityWarning] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    # Exactly 2 clusters found (A+C merged, B separate) -- if the matrix
    # rewrite had a bug, this would either fragment into more/smaller
    # clusters (missed real similarities) or produce one giant cluster
    # (a stray always-true comparison merging everything).
    assert len(conflict_client.calls) == 2
    clustered_text_sets = [
        {text for pair in call.values() for text in pair.values()} for call in conflict_client.calls
    ]
    a_and_c_texts = {f"Group A statement {i}" for i in range(10)} | {
        f"Group C statement {i}" for i in range(5)
    }
    b_texts = {f"Group B statement {i}" for i in range(15)}
    assert a_and_c_texts in clustered_text_sets
    assert b_texts in clustered_text_sets
    # Every similar pair is asked (these texts state no values code could compare): 15 * 14 / 2 and 15 * 14 / 2.
    assert sorted(len(call) for call in conflict_client.calls) == [105, 105]


def test_detect_conflicting_duplicates_does_not_cluster_unrelated_bodies_under_one_shared_title() -> (
    None
):
    # Over-clustering safety net for the title+description blend: two nodes
    # legitimately carry the SAME title over totally unrelated bodies (a
    # "Power Supply" section states an input voltage in one place and a paint
    # spec in another). Blending must not manufacture a cluster the
    # description-alone code would never have produced -- the title is at most
    # HALF of each blended vector, so unrelated descriptions stay under
    # threshold even when the titles are byte-identical.
    title = "Power Supply"
    text_a = "The power supply shall accept an input of 28V DC from the platform."
    text_b = "The power supply enclosure shall be painted per MIL-STD-171."
    nodes = [_req_node("n0", text_a, title=title), _req_node("n1", text_b, title=title)]
    # Unit vectors: the descriptions are genuinely unrelated (cosine 0.2),
    # while the shared title is plausibly close to BOTH (cosine 0.6 to each)
    # -- the worst realistic case for the blend, not an artificially
    # orthogonal title. Blended cosine: 0.75, under the 0.85 threshold.
    # Title-alone would be 1.0, which is what this test exists to forbid.
    embed_client = _FakeEmbedClientForConflicts(
        {
            title: [0.6, 0.4899, 0.6325],
            text_a: [1.0, 0.0, 0.0],
            text_b: [0.2, 0.9798, 0.0],
        }
    )
    conflict_client = _FakeConflictClient("yes", "no")
    warnings: list[IntegrityWarning] = []

    _detect_conflicting_duplicates(nodes, embed_client, conflict_client, warnings)

    assert conflict_client.calls == []  # an identical title alone must never cluster
    assert warnings == []


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

    def group_root_topics(self, titles_by_id: dict[str, str], user_id: str | None = None) -> dict:
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


def test_regroup_disconnected_roots_emits_no_narration_when_it_is_a_noop() -> None:
    nodes = [_node("n0", WorkItemType.FEATURE, None, "Only Root")]
    events: list[LevelingProgress] = []

    _regroup_disconnected_roots(nodes, "regroup_", None, [], events.append)

    assert events == []


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
        def group_root_topics(
            self, titles_by_id: dict[str, str], user_id: str | None = None
        ) -> dict:
            raise RuntimeError("boom")

    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    warnings: list[str] = []
    _regroup_disconnected_roots(nodes, "regroup_", RaisingGroupingClient(), warnings)
    assert nodes[0].parent_local_id is None
    assert nodes[1].parent_local_id is None


class _FakeDebugCapture:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def capture(self, kind: str, identifier: str, raw_response: str) -> None:
        self.calls.append((kind, identifier, raw_response))


# ---------------------------------------------------------------------------
# _regroup_disconnected_roots, second pass -- assign_leftover_roots. Real
# gap this closes: group_root_topics' own prompt already asks the model to
# re-check every unplaced title against every group it formed, in the SAME
# single non-reasoning generation -- confirmed live that a local model
# misses genuine near-fits even with that instruction present. This makes
# the re-check a real second decision, with the created groups as actual
# input.
# ---------------------------------------------------------------------------


class _FakeGroupingClientWithAssignment:
    """Deliberately a SEPARATE class from _FakeGroupingClient above, not an
    added method on it -- _FakeGroupingClient must stay exactly as it was
    so every existing test above continues to exercise the REAL regression
    guard: a client that only implements group_root_topics (which is what
    every real RootGroupingClient looked like before this pass existed)
    hits AttributeError on assign_leftover_roots and degrades to leaving
    leftovers exactly where they were, same as before this pass existed."""

    def __init__(self, group_result: dict, assignment_result: dict) -> None:
        self._group_result = group_result
        self._assignment_result = assignment_result
        self.assignment_calls: list[tuple[dict[str, str], dict[str, str]]] = []

    def group_root_topics(self, titles_by_id: dict[str, str], user_id: str | None = None) -> dict:
        return self._group_result

    def assign_leftover_roots(
        self,
        leftover_titles_by_id: dict[str, str],
        group_titles_by_id: dict[str, str],
        user_id: str | None = None,
    ) -> dict:
        self.assignment_calls.append((leftover_titles_by_id, group_titles_by_id))
        return self._assignment_result


def test_regroup_disconnected_roots_ignores_an_assignment_to_an_invented_group_id() -> None:
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
        _node("n2", WorkItemType.FEATURE, None, "Truly Standalone"),
    ]
    client = _FakeGroupingClientWithAssignment(
        {"groups": [{"title": "VPX Utility & Management Signals", "member_ids": ["n0", "n1"]}]},
        {"assignments": {"n2": "not_a_real_group_id"}},
    )
    _regroup_disconnected_roots(nodes, "regroup_", client, [])
    assert nodes[2].parent_local_id is None


def test_regroup_disconnected_roots_skips_the_second_pass_when_there_are_no_leftovers() -> None:
    # Every root got placed on the first pass -- nothing left to check
    # against the groups, so the second call must not fire at all.
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    client = _FakeGroupingClientWithAssignment(
        {"groups": [{"title": "VPX Utility & Management Signals", "member_ids": ["n0", "n1"]}]},
        {"assignments": {}},
    )
    _regroup_disconnected_roots(nodes, "regroup_", client, [])
    assert client.assignment_calls == []


def test_regroup_disconnected_roots_skips_the_second_pass_when_no_groups_were_created() -> None:
    # Nothing to check leftovers AGAINST -- the first pass formed no
    # groups at all, so the second call must not fire either.
    nodes = [
        _node("n0", WorkItemType.FEATURE, None, "PS_SYSRESET"),
        _node("n1", WorkItemType.FEATURE, None, "PS_SYNC"),
    ]
    client = _FakeGroupingClientWithAssignment({"groups": []}, {"assignments": {}})
    _regroup_disconnected_roots(nodes, "regroup_", client, [])
    assert client.assignment_calls == []
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


def test_build_survey_tree_defaults_primer_context_to_none_byte_identical() -> None:
    # None (the default) must be byte-identical to before this capability
    # existed -- same convention as every other optional *_client param.
    tree_without = build_survey_tree(_small_doc(), FakeSurveyModelClient())
    tree_with_none = build_survey_tree(
        _small_doc(), FakeSurveyModelClient(), primer_context=None
    )
    assert tree_without.nodes == tree_with_none.nodes


# ---------------------------------------------------------------------------
# Part B: the skeleton (stage 1) / content-authoring (stage 3) generation split
#
# One call per branch used to decide structure AND write every requirement at
# once. It is now two, with whole-document structural repair running between
# them -- so a node is authored against the ancestry it actually ships with,
# not one that was about to change underneath it.
# ---------------------------------------------------------------------------


# --- STAGE 2: whole-document figure/table -> exact-node mapping -------------
# The pass that produces the verdicts the seam tests above inject by hand:
# tier 1 batches one call per BRANCH (that branch's whole figure+table set,
# against that branch's own nodes), tier 2 batches only the escalated
# leftovers against the WHOLE document's nodes. Never one call per figure --
# at the 918-figure scale this exists for, that would double the job's
# dominant cost.


# Acceptance-criteria step wired into build_survey_tree (P9) ----


class _CriteriaSpy:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.backgrounds: list[str | None] = []

    def propose_acceptance_criteria(self, items_by_id, user_id=None, background=None):
        self.calls.append(items_by_id)
        self.backgrounds.append(background)
        return {
            k: {
                "criteria": ["Check HDR output on a reference display."],
                "assumptions": [],
                "needs_author_input": False,
            }
            for k in items_by_id
        }


_EMPTY_STUDY = {
    "glossary": [],
    "placeholder_tokens": [],
    "verification_statements": [],
    "standards_cited": [],
    "table_roles": [],
}


class _StudySpy:
    def __init__(self) -> None:
        self.windows: list[str] = []

    def study_document_window(self, window_text, user_id=None):
        self.windows.append(window_text)
        return {**_EMPTY_STUDY, "placeholder_tokens": []}


def _flagged_scoring() -> "FakeScoringClient":
    return FakeScoringClient(
        results={
            "n0": {"score": 90, "issues": []},
            "n1": {"score": 40, "issues": ["missing_acceptance_criteria"]},
        }
    )


def test_build_survey_tree_stores_study_windows_and_a_second_identical_call_makes_no_study_calls() -> (
    None
):
    from app.leveling.study_store import StudyStore

    class _Redis:
        def __init__(self) -> None:
            self.data: dict = {}

        def get(self, key):
            return self.data.get(key)

        def set(self, key, value, ex=None, nx=False):
            if nx and key in self.data:
                return None
            self.data[key] = value
            return True

        def delete(self, *keys):
            return sum(self.data.pop(key, None) is not None for key in keys)

    redis = _Redis()
    store = StudyStore(redis, 60)
    first_study, second_study = _StudySpy(), _StudySpy()

    for study in (first_study, second_study):
        build_survey_tree(
            _small_doc(),
            FakeSurveyModelClient(),
            scoring_client=_flagged_scoring(),
            acceptance_criteria_client=_CriteriaSpy(),
            document_study_client=study,
            study_store=store,
            user_id="user-a",
        )

    assert len(first_study.windows) == 1 and second_study.windows == []
    assert len(redis.data) == 1 and "user-a" not in next(iter(redis.data))


def test_build_survey_tree_gives_the_criteria_step_the_context_primer() -> None:
    criteria = _CriteriaSpy()

    build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        scoring_client=_flagged_scoring(),
        acceptance_criteria_client=criteria,
        primer_context="A radar interface control document.",
    )

    assert criteria.backgrounds and set(criteria.backgrounds) == {
        "A radar interface control document."
    }


def test_build_survey_tree_without_eligible_requirements_proposes_nothing_and_stops_the_study(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        llm_leveling_module, "eligible_nodes", lambda nodes: []
    )  # eligibility is decided by the text (see test_acceptance_criteria)
    criteria, study = _CriteriaSpy(), _StudySpy()
    scoring = FakeScoringClient(
        results={"n0": {"score": 90, "issues": []}, "n1": {"score": 90, "issues": []}}
    )

    build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        scoring_client=scoring,
        acceptance_criteria_client=criteria,
        document_study_client=study,
    )

    assert (
        criteria.calls == []
    )  # the study now starts with the job, so a window may already have been read; it is stopped, not joined


def test_build_survey_tree_without_a_criteria_client_is_unchanged() -> None:
    tree = build_survey_tree(
        _small_doc(), FakeSurveyModelClient(), scoring_client=_flagged_scoring()
    )

    assert all("Proposed acceptance criteria" not in n.description for n in tree.nodes)


class _CriteriaForEveryKey:
    """Scores every requirement as lacking acceptance criteria, whatever its local id."""

    def score_requirements_for_document(
        self,
        descriptions_by_node_id,
        criteria_context=None,
        kb_context=None,
        category_checklist=None,
        user_id=None, together=False,
    ):
        return {
            k: {"score": 40, "issues": ["missing_acceptance_criteria"]}
            for k in descriptions_by_node_id
        }


def test_build_survey_tree_proposes_criteria_on_the_fully_deterministic_path_too() -> None:
    criteria, study = _CriteriaSpy(), _StudySpy()

    tree = build_survey_tree(
        _structural_heading_doc(),
        FakeSurveyModelClient(),
        scoring_client=_CriteriaForEveryKey(),
        acceptance_criteria_client=criteria,
        document_study_client=study,
    )

    assert any(
        "Proposed acceptance criteria" in n.description
        for n in tree.nodes
        if n.type == WorkItemType.REQUIREMENT
    )
    assert len(study.windows) == 1 and "The system shall do A." in study.windows[0]


class _BrokenStudy:
    def study_document_window(self, window_text, user_id=None):
        raise RuntimeError("model down")


def test_build_survey_tree_warns_when_the_document_could_not_be_studied_but_still_proposes() -> (
    None
):
    tree = build_survey_tree(
        _small_doc(),
        FakeSurveyModelClient(),
        scoring_client=_flagged_scoring(),
        acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=_BrokenStudy(),
    )

    assert any(
        "read none of the document" in w.raw for w in tree.warnings
    )  # the study's own wording, now that it runs in the background
    assert any("Proposed acceptance criteria" in n.description for n in tree.nodes)


class _FailsOnSecondWindow:
    def __init__(self) -> None:
        self.calls = 0

    def study_document_window(self, window_text, user_id=None):
        self.calls += 1
        if self.calls == 2:
            raise RuntimeError("model down")
        return {**_EMPTY_STUDY, "placeholder_tokens": []}


def _long_doc() -> CanonicalDoc:
    path = "long_input.txt"
    text = "The display shall support HDR. " * 800  # ~24k characters: two study windows (20k each)
    return CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"),
        blocks=[
            Block(id="b0", kind=BlockKind.PARAGRAPH, text="Display", source_ref=_sr(path)),
            Block(id="b1", kind=BlockKind.PARAGRAPH, text=text, source_ref=_sr(path)),
        ],
    )


def test_a_partly_read_document_warns_with_how_much_was_read() -> None:
    study = _FailsOnSecondWindow()

    tree = build_survey_tree(
        _long_doc(),
        FakeSurveyModelClient(),
        scoring_client=_flagged_scoring(),
        acceptance_criteria_client=_CriteriaSpy(),
        document_study_client=study,
    )

    assert study.calls == 2
    assert any("1 of 2 parts" in w.raw for w in tree.warnings)


def test_a_document_with_no_readable_text_is_not_studied_and_does_not_warn() -> None:
    from app.leveling.llm_leveling import _propose_criteria_step
    from app.leveling.study_runner import StudyHandle

    path = "empty.txt"
    empty = CanonicalDoc(
        document=Document(path=path, format=DocumentFormat.TXT, sha256="h"), blocks=[]
    )
    node = WorkItemNode(
        local_id="r",
        parent_local_id=None,
        type=WorkItemType.REQUIREMENT,
        title="r",
        description="The unit shall x.",
        source_ref=_sr(path),
        mode=WorkItemMode.SURVEY,
        quality_issues=[RequirementQualityIssue.NOT_TESTABLE],
    )
    study, warnings = _StudySpy(), []
    handle = StudyHandle.from_settings(  # the step joins a started study: it no longer reads the document itself
        render_text=lambda: render_section(empty.blocks, empty.tables),
        client=study,
        user_id=None,
        scope="s",
        model=None,
        store=None,
        limiter=None,
    )
    handle.start()
    try:
        _propose_criteria_step([node], empty, _CriteriaSpy(), study, warnings, study_handle=handle)
    finally:
        handle.close()

    assert study.windows == []
    assert warnings == []
    assert "Proposed acceptance criteria" in node.description


# cancellation and the user-less call in the criteria step (fix pass T4b) ----


class _CancelledStudy:
    def study_document_window(self, window_text, user_id=None):
        raise JobCancelled("gone")


class _CancelledCriteria:
    def propose_acceptance_criteria(self, items_by_id, user_id=None):
        raise JobCancelled("gone")


def _flagged_requirement() -> WorkItemNode:
    return WorkItemNode(
        local_id="r",
        parent_local_id=None,
        type=WorkItemType.REQUIREMENT,
        title="r",
        description="The display shall support HDR.",
        source_ref=_sr("survey_input.txt"),
        mode=WorkItemMode.SURVEY,
        quality_issues=[RequirementQualityIssue.NOT_TESTABLE],
    )


def test_criteria_step_propagates_a_criteria_cancellation_without_a_warning() -> None:
    from app.leveling.llm_leveling import _propose_criteria_step

    warnings: list = []

    with pytest.raises(
        JobCancelled
    ):  # a study's own cancellation comes through the handle (tests/test_study_wiring.py) and the wrapper (below)
        _propose_criteria_step(
            [_flagged_requirement()], _small_doc(), _CancelledCriteria(), None, warnings
        )

    assert warnings == []


@pytest.mark.parametrize(
    "study_client, criteria_client",
    [(_CancelledStudy(), _CriteriaSpy()), (_StudySpy(), _CancelledCriteria())],
)
def test_build_survey_tree_propagates_a_cancellation_from_the_study_or_the_criteria_client(
    study_client, criteria_client
) -> None:
    with pytest.raises(JobCancelled):
        build_survey_tree(
            _small_doc(),
            FakeSurveyModelClient(),
            scoring_client=_flagged_scoring(),
            acceptance_criteria_client=criteria_client,
            document_study_client=study_client,
        )


def test_a_call_without_a_user_id_never_touches_the_study_store() -> None:
    from app.leveling.study_store import StudyStore

    class _SpyRedis:
        def __init__(self) -> None:
            self.calls: list = []

        def get(self, *args, **kwargs):
            self.calls.append("get")

        def set(self, *args, **kwargs):
            self.calls.append("set")
            return True

        def delete(self, *args, **kwargs):
            self.calls.append("delete")

    redis, study = _SpyRedis(), _StudySpy()

    for user_id in (None, ""):
        build_survey_tree(
            _small_doc(),
            FakeSurveyModelClient(),
            scoring_client=_flagged_scoring(),
            acceptance_criteria_client=_CriteriaSpy(),
            document_study_client=study,
            study_store=StudyStore(redis, 60),
            user_id=user_id,
        )

    assert (
        redis.calls == [] and len(study.windows) == 2
    )  # read afresh each time, nothing stored or reused


def test_merge_always_include_context_marks_its_citations_as_always_included() -> None:
    from app.leveling.llm_leveling import _merge_always_include_context
    from app.workitem.model import KbCitation, KbCitationRelevance

    retrieved = KbCitation(
        source_file="spec.docx", similarity=0.42, relevance=KbCitationRelevance.NOT_RELEVANT
    )
    prefetched = (
        "guide text",
        [
            {
                "source_file": "guide.pptx",
                "similarity": 1.0,
                "text": "guide text",
                "truncated": False,
            }
        ],
    )

    _, citations = _merge_always_include_context(
        "ctx",
        [retrieved],
        "u",
        None,
        prefetched=prefetched,  # type: ignore[arg-type]
    )

    by_file = {c.source_file: c for c in citations}
    assert by_file["guide.pptx"].inclusion == "always"
    assert by_file["guide.pptx"].relevance == KbCitationRelevance.RELEVANT
    # A retrieved citation keeps the default.
    assert by_file["spec.docx"].inclusion == "retrieved"


def test_trace_links_count_their_own_items_not_chunks_through_the_stage_counter(monkeypatch) -> None:  # noqa: ANN001
    calls: list[tuple] = []

    class _Counter:
        def set_total(self, stage: str, total: int) -> None:
            calls.append(("set_total", stage, total))

        def advance(self, stage: str, count: int) -> None:
            calls.append(("advance", stage, count))

        def complete(self, stage: str) -> None:
            calls.append(("complete", stage, 0))

    monkeypatch.setattr("app.leveling.trace_links.current_stage_counter", lambda: _Counter())
    nodes = [_req_node(f"n{i}", f"The system shall do thing {i}.") for i in range(3)]
    _infer_trace_links_for_nodes(nodes, FakeTraceLinkInferenceClient(results=[]), [], [], None, 0, 0)

    assert calls[0] == ("set_total", "trace", 3)
    assert sum(count for kind, _stage, count in calls if kind == "advance") == 3
    # Marked complete when its last chunk answers, so the screen never shows "3 of 3" still working.
    assert calls[-1] == ("complete", "trace", 0)
