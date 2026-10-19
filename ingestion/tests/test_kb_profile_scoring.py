"""Requirement scoring reads the KB profile: one category list for the whole job, no raw KB text on the requests."""
from __future__ import annotations

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.kb.profile import build_profile
from app.leveling.llm_leveling import build_survey_tree
from tests.test_kb_profile import DOCS, FakeProfileClient
from tests.test_structure_contract import StructureRefusingClient, TitleHashEmbedder


class CapturingScorer:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def score_requirements_for_document(self, descriptions_by_node_id, criteria_context=None, kb_context=None, category_checklist=None, user_id=None):
        self.calls.append({"n": len(descriptions_by_node_id), "kb_context": kb_context, "checklist": category_checklist})
        return {node_id: {"score": 80, "issues": [], "categoryScores": {name: 80 for name in (category_checklist or [])}} for node_id in descriptions_by_node_id}

    def score_epics_and_features_for_document(self, *args, **kwargs):
        return {}


def _doc() -> CanonicalDoc:
    ref = SourceRef(document_path="x.txt", start_offset=0, end_offset=10)
    return CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id=f"b{i}", kind=BlockKind.PARAGRAPH, text=f"The receiver shall do thing number {i}.", source_ref=ref) for i in range(6)],
    )


def _run(profile, mode="baseline"):
    scorer = CapturingScorer()
    build_survey_tree(
        _doc(), StructureRefusingClient(), scoring_client=scorer, embed_client=TitleHashEmbedder(),
        structure_mode=mode, root_regroup_mode="deterministic", kb_profile=profile, user_id="u1",
    )
    return scorer


def test_with_a_profile_every_scoring_batch_uses_the_profile_categories_and_a_small_context() -> None:
    profile = build_profile(DOCS, FakeProfileClient(), model="m1")
    scorer = _run(profile)

    assert scorer.calls, "requirements must be scored"
    expected = [c.name for c in profile.categories]
    assert all(call["checklist"] == expected for call in scorer.calls)
    assert all(call["kb_context"] and len(call["kb_context"]) < 8_000 for call in scorer.calls)
    assert "Mandatory writing rules" in scorer.calls[0]["kb_context"]


def test_without_a_profile_scoring_is_exactly_what_it_was() -> None:
    scorer = _run(None)
    assert all(call["checklist"] is None and call["kb_context"] is None for call in scorer.calls)


def test_a_profile_without_categories_changes_nothing() -> None:
    empty = build_profile({"notes.docx": "prose"}, FakeProfileClient(), model="m1")
    scorer = _run(empty)
    assert all(call["checklist"] is None for call in scorer.calls)
