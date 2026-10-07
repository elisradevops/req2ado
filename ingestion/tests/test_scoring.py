import logging

from app.canonical.model import SourceRef
from app.leveling.scoring import (
    _CANARY_MAX_SCORE,
    _CANARY_NODE_ID,
    _CANARY_TEXT,
    _apply_quality_scores,
    _match_category_checklist,
    score_single_requirement_text,
)
from app.workitem.model import IntegrityWarning, QualityConfidence, WorkItemMode, WorkItemNode, WorkItemType


def _requirement_node(local_id: str, description: str) -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id, parent_local_id=None, type=WorkItemType.REQUIREMENT,
        title=local_id, description=description,
        source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1),
        mode=WorkItemMode.SURVEY,
    )


class _FakeScoringClient:
    def __init__(self, response: dict) -> None:
        self._response = response
        self.calls: list[tuple] = []

    def score_requirements_for_document(
        self, descriptions_by_node_id, criteria_context=None, kb_context=None,
        category_checklist=None, user_id=None,
    ):
        self.calls.append(
            (descriptions_by_node_id, criteria_context, kb_context, category_checklist)
        )
        return self._response


def test_returns_parsed_score_issues_and_category_scores() -> None:
    client = _FakeScoringClient(
        {
            "adhoc": {
                "score": 72,
                "issues": ["vague_term", "not_a_real_issue"],
                "categoryScores": {"clarity": 60},
            },
        },
    )

    score, issues, category_scores, _confidence = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score == 72
    # "not_a_real_issue" is outside the closed vocabulary and silently
    # dropped, same tolerant philosophy as _apply_quality_scores.
    assert issues == ["vague_term"]
    assert category_scores == {"clarity": 60}


def test_confidence_round_trips_through_single_requirement_scoring() -> None:
    client = _FakeScoringClient({"adhoc": {"score": 80, "issues": [], "categoryScores": {"clarity": 80}, "confidence": "low"}})

    score, issues, category_scores, confidence = score_single_requirement_text(
        "The system shall do a thing.", client, None, None, None,
    )

    assert score == 80
    assert confidence is QualityConfidence.LOW
    # The score is NOT invalidated or dropped by low confidence -- see
    # QualityConfidence's own docstring. Everything else is untouched.
    assert issues == []
    assert category_scores == {"clarity": 80}


def test_missing_confidence_falls_back_to_none_without_crashing() -> None:
    # responseSchema is best-effort in this system (an Ollama version that
    # rejects response_format degrades to a schema-less retry), so an entry
    # with no 'confidence' key at all is a REAL, expected shape -- it must
    # parse to None, not raise, exactly like a missing categoryScores does.
    client = _FakeScoringClient({"adhoc": {"score": 80, "issues": [], "categoryScores": {"clarity": 80}}})

    _, _, _, confidence = score_single_requirement_text("The system shall do a thing.", client, None, None, None)

    assert confidence is None


def test_unknown_confidence_value_falls_back_to_none() -> None:
    # A model that answers "very high" / 0.9 / None must not crash the
    # batch or smuggle an off-vocabulary value into WorkItemNode -- same
    # closed-vocabulary tolerance as the 'issues' filter right beside it.
    for bad in ["very high", "LOW ", 0.9, None, ["low"]]:
        client = _FakeScoringClient({"adhoc": {"score": 80, "issues": [], "categoryScores": {}, "confidence": bad}})
        _, _, _, confidence = score_single_requirement_text("x shall y.", client, None, None, None)
        assert confidence is None, f"expected None for {bad!r}"


def test_sends_the_single_description_under_an_adhoc_key() -> None:
    client = _FakeScoringClient({"adhoc": {"score": 50, "issues": [], "categoryScores": None}})

    score_single_requirement_text(
        "The system shall do x.", client, None, "kb ctx", ["clarity", "rationale"],
    )

    descriptions_by_node_id, criteria_context, kb_context, category_checklist = client.calls[0]
    assert descriptions_by_node_id == {"adhoc": "The system shall do x."}
    assert criteria_context is None  # no retriever supplied
    assert kb_context == "kb ctx"
    # The exact rubric this rescore must be judged against, forced through
    # unchanged -- this is the whole determinism guarantee the feature
    # depends on.
    assert category_checklist == ["clarity", "rationale"]


def test_missing_score_entry_returns_none_score_and_empty_issues() -> None:
    client = _FakeScoringClient({})  # the LLM returned no entry for "adhoc" at all

    score, issues, category_scores, _confidence = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score is None
    assert issues == []
    assert category_scores is None


def test_malformed_score_out_of_range_falls_back_to_none() -> None:
    client = _FakeScoringClient({"adhoc": {"score": 150, "issues": [], "categoryScores": None}})

    score, _issues, _category_scores, _confidence = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score is None


def test_boolean_score_is_rejected_same_as_batched_scoring() -> None:
    # bool is a subclass of int in Python -- isinstance(True, int) is True --
    # so this must be excluded explicitly, same guard _apply_quality_scores
    # already has for the batched path.
    client = _FakeScoringClient({"adhoc": {"score": True, "issues": [], "categoryScores": None}})

    score, _issues, _category_scores, _confidence = score_single_requirement_text(
        "The system shall do x.", client, None, None, None,
    )

    assert score is None


class _RecordingCriteriaRetriever:
    def __init__(self) -> None:
        self.queries: list[str] = []

    def retrieve(self, text: str, top_k: int = 3):
        self.queries.append(text)
        from app.quality.criteria_corpus import QualityCriterion
        from app.workitem.model import RequirementQualityIssue

        return [
            QualityCriterion(issue=RequirementQualityIssue.VAGUE_TERM, text="Avoid vague terms."),
        ]


def test_builds_criteria_context_from_the_retriever_when_supplied() -> None:
    retriever = _RecordingCriteriaRetriever()
    client = _FakeScoringClient({"adhoc": {"score": 40, "issues": [], "categoryScores": None}})

    score_single_requirement_text("The system shall be fast.", client, retriever, None, None)

    assert retriever.queries == ["The system shall be fast."]
    _descriptions, criteria_context, _kb_context, _checklist = client.calls[0]
    assert criteria_context == "- vague_term: Avoid vague terms."


def test_blank_description_skips_criteria_retrieval() -> None:
    retriever = _RecordingCriteriaRetriever()
    client = _FakeScoringClient({"adhoc": {"score": 0, "issues": [], "categoryScores": None}})

    score_single_requirement_text("   ", client, retriever, None, None)

    assert retriever.queries == []


class TestMatchCategoryChecklist:
    """_match_category_checklist builds quality_category_checklist -- see
    its own docstring for the exact-match-only heuristic and its known
    limitations (model key drift, categories with no stated definition)."""

    def test_matches_keys_present_in_both(self) -> None:
        result = _match_category_checklist(
            {"Necessary": 80, "Unambiguous": 60},
            {"Necessary": "States something not already satisfied.", "Verifiable": "Can be objectively checked."},
        )
        assert result == {"Necessary": "States something not already satisfied."}

    def test_matches_case_insensitively_and_whitespace_normalized(self) -> None:
        # The scoring model is instructed to use category_checklist's names
        # VERBATIM, but this stays tolerant of minor case/whitespace drift
        # rather than losing a real match over it.
        result = _match_category_checklist(
            {"  necessary  ": 80}, {"Necessary": "Real definition."},
        )
        assert result == {"  necessary  ": "Real definition."}

    def test_no_match_for_a_key_with_no_stated_definition(self) -> None:
        # A category the org's document lists only by bare name (no
        # separate explanation) is a real, expected case -- correctly
        # produces no entry for it, not an error.
        result = _match_category_checklist(
            {"Necessary": 80, "Ranked": 70}, {"Necessary": "Real definition."},
        )
        assert result == {"Necessary": "Real definition."}
        assert "Ranked" not in result

    def test_returns_none_when_nothing_matches_at_all(self) -> None:
        result = _match_category_checklist(
            {"clarity": 80}, {"Necessary": "Real definition."},
        )
        assert result is None

    def test_returns_none_when_category_scores_is_none(self) -> None:
        assert _match_category_checklist(None, {"Necessary": "Real definition."}) is None

    def test_returns_none_when_no_definitions_were_supplied(self) -> None:
        assert _match_category_checklist({"Necessary": 80}, None) is None
        assert _match_category_checklist({"Necessary": 80}, {}) is None

    def test_always_injected_completeness_key_never_matches(self) -> None:
        # completeness_as_requirement is req2ado's own structural check,
        # added regardless of checklist source -- never part of any org's
        # document, so it correctly never has a checklist definition.
        result = _match_category_checklist(
            {"Necessary": 80, "completeness_as_requirement": 90},
            {"Necessary": "Real definition."},
        )
        assert result == {"Necessary": "Real definition."}
        assert "completeness_as_requirement" not in result


import threading
import time

from app.canonical.model import SourceRef
from app.leveling.scoring import _score_all_requirements, _score_epics_and_features
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemType


def _sr(offset: int = 0) -> SourceRef:
    return SourceRef(document_path="x.docx", start_offset=offset, end_offset=offset + 1)


def _requirement_nodes(count: int) -> list[WorkItemNode]:
    # _SCORING_CHUNK_NODE_COUNT is 150 and _score_all_requirements dedupes by
    # description BEFORE chunking, so every description must be distinct or
    # the chunk count collapses to 1 and the test passes vacuously.
    return [
        WorkItemNode(
            local_id=f"r{i}", parent_local_id=None, type=WorkItemType.REQUIREMENT,
            title=f"R{i}", description=f"The system shall do distinct thing number {i}.",
            source_ref=_sr(i), mode=WorkItemMode.SURVEY,
        )
        for i in range(count)
    ]


def _epic_nodes(count: int) -> list[WorkItemNode]:
    return [
        WorkItemNode(
            local_id=f"e{i}", parent_local_id=None, type=WorkItemType.EPIC,
            title=f"E{i}", description=f"Capability area {i}.",
            source_ref=_sr(i), mode=WorkItemMode.SURVEY,
        )
        for i in range(count)
    ]


def test_score_all_requirements_runs_chunks_concurrently() -> None:
    seen: set[str] = set()
    lock = threading.Lock()

    class ThreadRecordingClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            with lock:
                seen.add(threading.current_thread().name)
            time.sleep(0.05)
            return {node_id: {"score": 80, "issues": []} for node_id in descriptions_by_node_id}

    _score_all_requirements(
        _requirement_nodes(320), ThreadRecordingClient(), [], None, None, [], None, None, 0, 1,
        chunk_concurrency=3,
    )

    assert len(seen) > 1


def test_score_all_requirements_output_is_identical_serial_vs_concurrent() -> None:
    class OrderSensitiveClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            if "r0" in descriptions_by_node_id:
                time.sleep(0.2)
            return {
                node_id: {"score": 70 + (index % 10), "issues": ["ambiguous"], "categoryScores": {"clarity": 60}}
                for index, node_id in enumerate(descriptions_by_node_id)
            }

    def run(concurrency: int):
        nodes = _requirement_nodes(320)
        warnings: list = []
        _score_all_requirements(
            nodes, OrderSensitiveClient(), warnings, None, None, [], None, None, 0, 1,
            chunk_concurrency=concurrency,
        )
        return (
            [(n.local_id, n.quality_score, [i.value for i in n.quality_issues], n.quality_category_scores) for n in nodes],
            [w.raw for w in warnings],
        )

    assert run(1) == run(4)


def test_score_all_requirements_narrates_chunks_in_document_order_under_concurrency() -> None:
    class SlowFirstChunkClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            if "r0" in descriptions_by_node_id:
                time.sleep(0.2)
            return {node_id: {"score": 80, "issues": []} for node_id in descriptions_by_node_id}

    fired: list = []

    _score_all_requirements(
        _requirement_nodes(320), SlowFirstChunkClient(), [], None, None, [], fired.append, None, 0, 1,
        chunk_concurrency=4,
    )

    # ProgressBanner renders "batch N of M" straight off chunkIndex and its
    # percentage off blocksDone, both taken from the LAST event received --
    # so both must be monotonic regardless of completion order.
    starts = [e for e in fired if e.phase == "score_requirements"]
    dones = [e for e in fired if e.phase == "score_requirements_done"]
    assert [e.chunk_index for e in starts] == [0, 1, 2]
    assert [e.blocks_done for e in starts] == [0, 150, 300]
    assert [e.chunk_index for e in dones] == [0, 1, 2]
    assert [e.blocks_done for e in dones] == [150, 300, 320]


def test_score_all_requirements_one_failing_chunk_still_scores_the_others_under_concurrency() -> None:
    class SecondChunkRaisesClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            if "r150" in descriptions_by_node_id:
                raise RuntimeError("boom")
            return {node_id: {"score": 80, "issues": []} for node_id in descriptions_by_node_id}

    nodes = _requirement_nodes(320)
    warnings: list = []
    fired: list = []

    _score_all_requirements(
        nodes, SecondChunkRaisesClient(), warnings, None, None, [], fired.append, None, 0, 1,
        chunk_concurrency=4,
    )

    by_id = {n.local_id: n for n in nodes}
    assert by_id["r0"].quality_score == 80
    assert by_id["r319"].quality_score == 80
    assert by_id["r150"].quality_score is None
    assert any(w.kind.value == "scoring_failed" for w in warnings)
    assert any(e.phase == "chunk_warning" for e in fired)


def test_score_epics_and_features_runs_chunks_concurrently() -> None:
    seen: set[str] = set()
    lock = threading.Lock()

    class ThreadRecordingClient:
        def score_epics_and_features_for_document(self, nodes_by_id, user_id=None):
            with lock:
                seen.add(threading.current_thread().name)
            time.sleep(0.05)
            return {node_id: {"score": 75} for node_id in nodes_by_id}

    _score_epics_and_features(
        _epic_nodes(320), ThreadRecordingClient(), [], None, None, 0, 1, chunk_concurrency=3,
    )

    assert len(seen) > 1


def test_score_epics_and_features_output_is_identical_serial_vs_concurrent() -> None:
    class OrderSensitiveClient:
        def score_epics_and_features_for_document(self, nodes_by_id, user_id=None):
            if "e0" in nodes_by_id:
                time.sleep(0.2)
            return {
                node_id: {"score": 60 + (index % 20), "categoryScores": {"scopeCoherence": 55}}
                for index, node_id in enumerate(nodes_by_id)
            }

    def run(concurrency: int):
        nodes = _epic_nodes(320)
        warnings: list = []
        _score_epics_and_features(
            nodes, OrderSensitiveClient(), warnings, None, None, 0, 1, chunk_concurrency=concurrency,
        )
        return (
            [(n.local_id, n.quality_score, n.quality_category_scores) for n in nodes],
            [w.raw for w in warnings],
        )

    assert run(1) == run(4)


def test_score_epics_and_features_narrates_chunks_in_document_order_under_concurrency() -> None:
    class SlowFirstChunkClient:
        def score_epics_and_features_for_document(self, nodes_by_id, user_id=None):
            if "e0" in nodes_by_id:
                time.sleep(0.2)
            return {node_id: {"score": 75} for node_id in nodes_by_id}

    fired: list = []

    _score_epics_and_features(
        _epic_nodes(320), SlowFirstChunkClient(), [], fired.append, None, 0, 1, chunk_concurrency=4,
    )

    starts = [e for e in fired if e.phase == "score_requirements"]
    dones = [e for e in fired if e.phase == "score_requirements_done"]
    assert [e.chunk_index for e in starts] == [0, 1, 2]
    assert [e.blocks_done for e in starts] == [0, 150, 300]
    assert [e.chunk_index for e in dones] == [0, 1, 2]
    assert [e.blocks_done for e in dones] == [150, 300, 320]


class _CanaryObservingClient:
    """Records the exact batch it was handed and answers every key,
    including the sentinel, with a good score."""

    def __init__(self, canary_score: int = 5) -> None:
        self.batches: list[dict[str, str]] = []
        self._canary_score = canary_score

    def score_requirements_for_document(
        self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None,
        user_id=None,
    ) -> dict[str, dict]:
        self.batches.append(dict(descriptions_by_node_id))
        return {
            node_id: {
                "score": self._canary_score if node_id == _CANARY_NODE_ID else 90,
                "issues": [],
                "categoryScores": {"clarity": 90},
            }
            for node_id in descriptions_by_node_id
        }


def test_canary_is_sent_to_the_model_but_never_reaches_a_caller() -> None:
    nodes = [_requirement_node("n1", "The system shall emit a heartbeat every 1 s.")]
    warnings: list[IntegrityWarning] = []

    client = _CanaryObservingClient()
    _apply_quality_scores(nodes, client, warnings, "")

    # Sent: the sentinel really was in the batch the model saw.
    assert _CANARY_NODE_ID in client.batches[0]
    assert client.batches[0][_CANARY_NODE_ID] == _CANARY_TEXT
    # Never surfaced: no node, no warning, no id leak anywhere a caller,
    # the orchestrator, or a user could observe it.
    assert [n.local_id for n in nodes] == ["n1"]
    assert nodes[0].quality_score == 90
    assert warnings == []


def test_canary_never_appears_in_the_progress_callback_either() -> None:
    nodes = [_requirement_node("n1", "The system shall emit a heartbeat every 1 s.")]
    fired: list[object] = []

    _apply_quality_scores(nodes, _CanaryObservingClient(), [], "", progress_callback=fired.append)

    assert not any(_CANARY_NODE_ID in repr(event) for event in fired)


def test_drift_is_logged_when_the_canary_scores_too_high(caplog) -> None:
    # Force the exact failure this probe exists for: the model applies no
    # real rubric and rates a deliberately terrible requirement highly.
    nodes = [_requirement_node("n1", "The system shall emit a heartbeat every 1 s.")]
    warnings: list[IntegrityWarning] = []

    with caplog.at_level(logging.WARNING, logger="app.leveling.scoring"):
        _apply_quality_scores(nodes, _CanaryObservingClient(canary_score=95), warnings, "")

    # caplog's own capture handler already renders each record's message
    # (record.message = record.getMessage()) before it lands in
    # caplog.records -- re-applying `% r.args` on the already-substituted
    # string double-formats it and raises TypeError, since the rendered text
    # has no placeholders left.
    assert any("Scoring drift probe FAILED" in r.message for r in caplog.records)
    assert any("scored 95" in r.message for r in caplog.records)
    # Log-only: the job is untouched, and nothing user-visible mentions it.
    assert warnings == []
    assert nodes[0].quality_score == 90


def test_no_drift_log_when_the_canary_scores_low(caplog) -> None:
    nodes = [_requirement_node("n1", "The system shall emit a heartbeat every 1 s.")]

    with caplog.at_level(logging.WARNING, logger="app.leveling.scoring"):
        _apply_quality_scores(nodes, _CanaryObservingClient(canary_score=5), [], "")

    assert not any("drift probe" in r.message for r in caplog.records)


def test_canary_is_not_injected_when_the_kill_switch_is_off(monkeypatch) -> None:
    # survey_scoring_canary_enabled=False must fully disable the probe: no
    # sentinel in the batch the model sees, no popped entry, no drift check.
    import app.leveling.scoring as scoring_module

    monkeypatch.setattr(scoring_module.settings, "survey_scoring_canary_enabled", False)

    nodes = [_requirement_node("n1", "The system shall emit a heartbeat every 1 s.")]
    warnings: list[IntegrityWarning] = []
    client = _CanaryObservingClient()

    _apply_quality_scores(nodes, client, warnings, "")

    assert _CANARY_NODE_ID not in client.batches[0]
    assert nodes[0].quality_score == 90
    assert warnings == []


def test_absent_canary_entry_is_itself_logged_as_drift(caplog) -> None:
    # The prompt demands one entry per input key, so a missing sentinel is a
    # real signal (stopped honoring the instruction, or a truncated
    # response) -- distinct message, same log-only treatment.
    class _IgnoresTheCanaryClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            return {"n1": {"score": 90, "issues": [], "categoryScores": {"clarity": 90}}}

    nodes = [_requirement_node("n1", "The system shall emit a heartbeat every 1 s.")]
    warnings: list[IntegrityWarning] = []

    with caplog.at_level(logging.WARNING, logger="app.leveling.scoring"):
        _apply_quality_scores(nodes, _IgnoresTheCanaryClient(), warnings, "")

    assert any("got no usable entry back" in r.message for r in caplog.records)
    assert warnings == []


def test_score_all_requirements_splits_a_timed_out_chunk_and_scores_every_node() -> None:
    import httpx

    calls: list[int] = []

    class TimesOutOnFullChunkClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            calls.append(len(descriptions_by_node_id))
            # Real batches carry the canary too, so only a call big enough to
            # be the full 100-node chunk times out; its halves succeed.
            if len(descriptions_by_node_id) > 60:
                raise httpx.ReadTimeout("timed out")
            return {node_id: {"score": 80, "issues": []} for node_id in descriptions_by_node_id}

    nodes = _requirement_nodes(100)
    warnings: list = []

    _score_all_requirements(nodes, TimesOutOnFullChunkClient(), warnings, None, None, [], None, None, 0, 1)

    assert all(n.quality_score == 80 for n in nodes)
    assert not any(w.kind.value == "scoring_failed" for w in warnings)
    assert len(calls) == 3  # the full chunk, then each half once


def test_score_all_requirements_reports_only_the_half_that_still_times_out() -> None:
    import httpx

    class SecondHalfAlwaysTimesOutClient:
        def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
            if len(descriptions_by_node_id) > 60 or "r99" in descriptions_by_node_id:
                raise httpx.ReadTimeout("timed out")
            return {node_id: {"score": 70, "issues": []} for node_id in descriptions_by_node_id}

    nodes = _requirement_nodes(100)
    warnings: list = []

    _score_all_requirements(nodes, SecondHalfAlwaysTimesOutClient(), warnings, None, None, [], None, None, 0, 1)

    by_id = {n.local_id: n for n in nodes}
    assert by_id["r0"].quality_score == 70
    assert by_id["r99"].quality_score is None
    failed = [w for w in warnings if w.kind.value == "scoring_failed"]
    assert len(failed) == 1
    assert "r99" in failed[0].node_ids and "r0" not in failed[0].node_ids
    assert failed[0].detail["errorType"] == "ReadTimeout"
    assert failed[0].detail["scope"] == "requirement"
    assert "timeoutSeconds" in failed[0].detail and "chunkChars" in failed[0].detail


def test_scoring_chunks_close_on_the_character_budget_not_just_the_node_count() -> None:
    from app.leveling import scoring

    items = ["x" * 15_000, "x" * 15_000, "x" * 15_000, "x" * 100]
    chunks = scoring._chunk_by_count_and_chars(items, len)

    assert [len(c) for c in chunks] == [2, 2]  # 30k fits the 40k budget, a third 15k does not
    assert scoring._chunk_by_count_and_chars(["y" * 90_000], len) == [["y" * 90_000]]  # oversized item gets its own chunk


def test_scoring_missing_carries_a_reason_telling_total_failure_from_partial() -> None:
    nodes = [_requirement_node("a", "The system shall do A."), _requirement_node("b", "The system shall do B.")]
    warnings: list = []
    _apply_quality_scores(nodes, _FakeScoringClient({}), warnings, "")
    missing = [w for w in warnings if w.kind.value == "scoring_missing"]
    assert missing and missing[0].detail["reason"] == "no_matching_keys"

    nodes = [_requirement_node("a", "The system shall do A."), _requirement_node("b", "The system shall do B.")]
    warnings = []
    _apply_quality_scores(
        nodes, _FakeScoringClient({"a": {"score": 80, "issues": [], "categoryScores": {}, "confidence": "high"}}), warnings, "",
    )
    missing = [w for w in warnings if w.kind.value == "scoring_missing"]
    assert missing and missing[0].detail["reason"] == "partial"
