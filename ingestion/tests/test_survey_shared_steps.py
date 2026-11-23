"""The SURVEY steps that run on every tree, checked on the structure the document itself gives (the only structure path): requirement
scoring, trace/coverage links, KB coverage and the warnings about external references. The scripted clients answer by requirement text, so
the tests do not depend on how the generated ids are numbered."""

from __future__ import annotations

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat
from app.kb.kb_vector_store import KbVectorStore
from app.leveling.llm_leveling import build_survey_tree
from app.workitem.model import KbCoverage
from tests.test_llm_leveling import _kb_hit, _sr, _stub_kb_documents

_PATH = "shared_steps.docx"
_HDR = "The display shall support HDR."
_DIM = "The display shall dim at night, see HDR."
_RELATED = [
    {"reference_name": "System.LinkTypes.Related", "name": "Related", "semantic_hint": None}
]


def _heading(block_id: str, text: str, level: int) -> Block:
    return Block(
        id=block_id, kind=BlockKind.HEADING, text=text, heading_level=level, source_ref=_sr(_PATH)
    )


def _para(block_id: str, text: str) -> Block:
    return Block(id=block_id, kind=BlockKind.PARAGRAPH, text=text, source_ref=_sr(_PATH))


def _doc(*paragraphs: tuple[str, str]) -> CanonicalDoc:
    """One Feature heading with one sub-heading per (title, text): each sub-heading becomes one Requirement."""
    blocks = [_heading("h0", "Display", 1)]
    for i, (title, text) in enumerate(paragraphs, start=1):
        blocks += [_heading(f"h{i}", title, 2), _para(f"p{i}", text)]
    return CanonicalDoc(
        document=Document(path=_PATH, format=DocumentFormat.DOCX, sha256="h"), blocks=blocks
    )


def _two_requirements() -> CanonicalDoc:
    return _doc(("HDR", _HDR), ("Brightness", _DIM))


class _ScoringByText:
    """Answers each requirement by its text; a text it has no answer for gets a plain 90."""

    def __init__(self, by_text: dict[str, dict] | None = None, fail: bool = False) -> None:
        self._by_text = by_text or {}
        self._fail = fail
        self.calls: list[dict[str, str]] = []

    def score_requirements_for_document(
        self,
        descriptions_by_node_id,
        criteria_context=None,
        kb_context=None,
        category_checklist=None,
        user_id=None, together=False,
    ):
        self.calls.append(dict(descriptions_by_node_id))
        if self._fail:
            raise ValueError("boom")
        return {
            node_id: self._by_text.get(text, {"score": 90, "issues": []})
            for node_id, text in descriptions_by_node_id.items()
        }


class _LinksBetween:
    """Proposes the scripted links, naming nodes by their text: (source text, target text or external id, reference name, quote)."""

    def __init__(
        self, links: list[tuple] | None = None, extra: list | None = None, fail: bool = False
    ) -> None:
        self._links = links or []
        self._extra = extra or []
        self._fail = fail
        self.calls = 0

    def infer_trace_links(self, nodes, link_type_catalog, kb_context=None, user_id=None):
        self.calls += 1
        if self._fail:
            raise ValueError("malformed JSON in LLM response content: 'Based'")
        by_text = {node["text"]: node["node_id"] for node in nodes}
        proposed = [
            {
                "source_node_id": by_text[source],
                "target_ref": by_text.get(target, target),
                "reference_name": reference_name,
                "evidence_quote": quote,
            }
            for source, target, reference_name, quote in self._links
        ]
        return [*proposed, *self._extra]


def _by_text(tree) -> dict[str, object]:
    return {node.description: node for node in tree.nodes if node.type.value == "Requirement"}


# --- scoring ----------------------------------------------------------------------------------------------------------------------


def test_scoring_is_one_call_for_the_whole_document_and_only_for_requirements() -> None:
    scoring = _ScoringByText()
    tree = build_survey_tree(_two_requirements(), object(), scoring)

    assert len(scoring.calls) == 1
    sent = {text for text in scoring.calls[0].values()}
    assert {_HDR, _DIM} <= sent
    assert "Display" not in sent  # the Feature heading is not scored
    assert all(
        node.quality_score is None for node in tree.nodes if node.type.value != "Requirement"
    )


def test_category_scores_reach_the_node() -> None:
    categories = {"clarity": 20, "testability": 80, "atomicity": 90, "style": 60, "rationale": 10}
    scoring = _ScoringByText(
        {_HDR: {"score": 40, "issues": ["ambiguous"], "categoryScores": categories}}
    )
    node = _by_text(build_survey_tree(_two_requirements(), object(), scoring))[_HDR]

    assert node.quality_score == 40
    assert node.quality_category_scores == categories


def test_one_malformed_category_discards_the_whole_breakdown_but_keeps_the_score() -> None:
    categories = {"clarity": 20, "testability": 150, "atomicity": 90, "style": 60, "rationale": 10}
    scoring = _ScoringByText({_HDR: {"score": 40, "issues": [], "categoryScores": categories}})
    node = _by_text(build_survey_tree(_two_requirements(), object(), scoring))[_HDR]

    assert node.quality_category_scores is None
    assert node.quality_score == 40


def test_no_category_scores_leaves_the_breakdown_empty() -> None:
    node = _by_text(build_survey_tree(_two_requirements(), object(), _ScoringByText()))[_HDR]
    assert node.quality_category_scores is None


def test_only_issues_from_the_closed_vocabulary_are_kept() -> None:
    scoring = _ScoringByText(
        {
            _HDR: {"score": 40, "issues": ["ambiguous", "not_a_real_issue"]},
            _DIM: {"score": 95, "issues": []},
        }
    )
    nodes = _by_text(build_survey_tree(_two_requirements(), object(), scoring))

    assert [issue.value for issue in nodes[_HDR].quality_issues] == ["ambiguous"]
    assert nodes[_DIM].quality_score == 95


def test_a_boolean_score_is_rejected() -> None:
    scoring = _ScoringByText(
        {_HDR: {"score": True, "issues": []}, _DIM: {"score": 85, "issues": []}}
    )
    nodes = _by_text(build_survey_tree(_two_requirements(), object(), scoring))

    assert nodes[_HDR].quality_score is None
    assert nodes[_DIM].quality_score == 85


def test_a_scoring_failure_becomes_a_warning_and_the_tree_is_kept() -> None:
    tree = build_survey_tree(_two_requirements(), object(), _ScoringByText(fail=True))

    assert all(node.quality_score is None for node in tree.nodes)
    assert any("Requirement quality scoring failed" in w.raw for w in tree.warnings)
    assert {_HDR, _DIM} <= set(_by_text(tree))


def test_a_requirement_repeated_word_for_word_is_scored_once_and_both_get_the_result() -> None:
    scoring = _ScoringByText({_HDR: {"score": 55, "issues": ["ambiguous"], "confidence": "low"}})
    tree = build_survey_tree(
        _doc(("HDR", _HDR), ("Brightness", _DIM), ("HDR again", _HDR)), object(), scoring
    )

    assert list(scoring.calls[0].values()).count(_HDR) == 1
    repeated = [node for node in tree.nodes if node.description == _HDR]
    assert len(repeated) == 2
    assert {node.quality_score for node in repeated} == {55}
    assert all([issue.value for issue in node.quality_issues] == ["ambiguous"] for node in repeated)
    assert {node.quality_confidence for node in repeated} == {"low"}


def test_scoring_is_reported_to_the_progress_callback() -> None:
    events: list = []
    build_survey_tree(
        _two_requirements(), object(), _ScoringByText(), progress_callback=events.append
    )

    phases = [event.phase for event in events]
    assert phases.index("score_requirements") < phases.index("score_requirements_done")


def test_checklist_definitions_from_the_kb_reach_the_scored_node(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda *a, **k: ("KB text", [_kb_hit("standard.pdf", 0.9, "KB text")]),
    )
    store = KbVectorStore(persist_path=str(tmp_path))
    store.upsert_chunk(
        chunk_id="s1:standard.pdf:0",
        embedding=[1.0, 0.0, 0.0],
        text="checklist text",
        user_id="Project\\Area1",
        source_file="standard.pdf",
        source_id="s1",
        chunk_index=0,
        file_hash="h1",
        quality_checklist=["Necessary", "Unambiguous"],
        quality_checklist_definitions={"Necessary": "States something not already satisfied."},
    )
    scoring = _ScoringByText(
        {_HDR: {"score": 90, "issues": [], "categoryScores": {"Necessary": 80, "Unambiguous": 70}}}
    )
    tree = build_survey_tree(
        _two_requirements(),
        object(),
        scoring,
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=store,
    )
    node = _by_text(tree)[_HDR]

    assert node.quality_category_scores == {"Necessary": 80, "Unambiguous": 70}
    assert node.quality_category_checklist == {
        "Necessary": "States something not already satisfied."
    }


# --- trace links ------------------------------------------------------------------------------------------------------------------


def test_a_link_between_two_requirements_of_the_job_is_resolved_inside_the_job() -> None:
    links = _LinksBetween([(_DIM, _HDR, "System.LinkTypes.Related", "see HDR")])
    tree = build_survey_tree(
        _two_requirements(), object(), link_type_client=links, link_type_catalog=_RELATED
    )
    by_id = {node.local_id: node for node in tree.nodes}

    assert len(tree.trace_links) == 1
    link = tree.trace_links[0]
    assert by_id[link.source_local_id].description == _DIM
    assert link.target_kind == "intraJob"
    assert by_id[link.target_local_id].description == _HDR
    assert link.resolution_status == "pending"


def test_a_link_type_not_in_the_catalog_is_dropped() -> None:
    links = _LinksBetween(
        [
            (_DIM, _HDR, "Hallucinated.NotReal", "see HDR"),
            (_DIM, _HDR, "System.LinkTypes.Related", "see HDR"),
        ]
    )
    tree = build_survey_tree(
        _two_requirements(), object(), link_type_client=links, link_type_catalog=_RELATED
    )

    assert [link.reference_name for link in tree.trace_links] == ["System.LinkTypes.Related"]


def test_an_entry_that_is_not_an_object_is_skipped_and_the_valid_link_kept() -> None:
    links = _LinksBetween(
        [(_DIM, _HDR, "System.LinkTypes.Related", "see HDR")],
        extra=["a malformed bare string entry"],
    )
    tree = build_survey_tree(
        _two_requirements(), object(), link_type_client=links, link_type_catalog=_RELATED
    )

    assert len(tree.trace_links) == 1


def test_a_link_inference_failure_becomes_a_warning_and_no_links() -> None:
    tree = build_survey_tree(
        _two_requirements(),
        object(),
        link_type_client=_LinksBetween(fail=True),
        link_type_catalog=_RELATED,
    )

    assert tree.trace_links == []
    assert {_HDR, _DIM} <= set(_by_text(tree))
    assert any("Trace/coverage link inference failed" in w.raw for w in tree.warnings)


# --- KB coverage ------------------------------------------------------------------------------------------------------------------


def test_kb_coverage_counts_the_files_available_and_cited(monkeypatch) -> None:
    _stub_kb_documents(monkeypatch, ["a.pdf", "b.pdf", "c.pdf"])
    monkeypatch.setattr(
        "app.leveling.llm_leveling.retrieve_context",
        lambda *a, **k: ("KB", [_kb_hit("a.pdf", 0.9, "KB"), _kb_hit("b.pdf", 0.8, "KB")]),
    )
    events: list = []
    tree = build_survey_tree(
        _two_requirements(),
        object(),
        _ScoringByText(),  # a later step, so an event fires after the KB was counted
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
        progress_callback=events.append,
    )

    assert tree.kb_coverage == KbCoverage(files_available=3, files_cited=2)
    assert any(event.kb_files_available == 3 for event in events)


def test_a_kb_listing_failure_does_not_fail_the_job(monkeypatch) -> None:
    def _boom(self, user_id):
        raise RuntimeError("chroma down")

    monkeypatch.setattr(KbVectorStore, "list_documents", _boom)
    monkeypatch.setattr("app.leveling.llm_leveling.retrieve_context", lambda *a, **k: (None, []))
    tree = build_survey_tree(
        _two_requirements(),
        object(),
        user_id="Project\\Area1",
        embed_client=object(),
        vector_store=KbVectorStore(persist_path="/tmp/unused-in-this-test"),
    )

    assert tree.kb_coverage is None
    assert {_HDR, _DIM} <= set(_by_text(tree))


# --- references to documents the job did not ingest -----------------------------------------------------------------------------


def test_a_numbered_external_reference_is_flagged_once_however_often_it_appears() -> None:
    tree = build_survey_tree(
        _doc(
            ("Pinout", "See ReqID 12345 for the full connector pinout."),
            ("Again", "Also see reqid 12345 for the pin list."),
        ),
        object(),
    )
    flagged = [w for w in tree.warnings if "did not ingest" in w.raw]

    assert len(flagged) == 1
    assert "ReqID 12345" in flagged[0].raw


def test_an_unfilled_reqid_placeholder_is_flagged() -> None:
    tree = build_survey_tree(_doc(("EMI", "According to ReqID XXXX: EMI/EMC table.")), object())
    assert any("ReqID" in w.raw and "did not ingest" in w.raw for w in tree.warnings)
