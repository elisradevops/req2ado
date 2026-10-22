"""/level hands the user's KB profile to the survey tree: built once (pinned to one model), never failing the job."""
from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.config import settings
from app.kb.profile import InMemoryProfileStore
from app.main import app
from app.workitem.model import WorkItemTree
from tests.test_kb_profile import DOCS, FakeProfileClient, _Kb

client = TestClient(app)


def _doc_json() -> str:
    ref = SourceRef(document_path="x.txt", start_offset=0, end_offset=10)
    doc = CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="The receiver shall do a thing.", source_ref=ref)],
    )
    return doc.model_dump_json()


def _level(store, kb, fake, model="job-model", user="u1"):
    captured: dict = {}

    def fake_build(*args, **kwargs):
        captured.update(kwargs)
        return WorkItemTree(nodes=[], warnings=[])

    with patch("app.main._kb_profile_store", store), patch("app.main._kb_vector_store", kb), \
            patch("app.main._make_profile_client", lambda m: fake), patch("app.main.build_survey_tree", fake_build):
        response = client.post(
            f"/level?mode=survey&model={model}", content=_doc_json(),
            headers={"Content-Type": "application/json", "X-Req2Ado-User-Id": user},
        )
    assert response.status_code == 200, response.text
    return captured.get("kb_profile")


def test_the_profile_is_built_for_the_job_and_reused_for_the_next(monkeypatch) -> None:
    monkeypatch.setattr(settings, "kb_profile_model", "")
    store, kb, fake = InMemoryProfileStore(), _Kb(DOCS), FakeProfileClient()
    first = _level(store, kb, fake)
    assert first is not None and first.docs_contributing == 3 and first.built_with == "job-model"
    calls = len(fake.extract_calls)
    assert _level(store, kb, fake).version == first.version and len(fake.extract_calls) == calls


def test_a_job_on_another_model_does_not_rebuild_a_profile_that_is_still_current(monkeypatch) -> None:
    # Pinned to the model that built it: otherwise two models alternating on one KB would rebuild it every time and the
    # categories (hence the scores) would depend on which model ran last.
    monkeypatch.setattr(settings, "kb_profile_model", "")
    store, kb, fake = InMemoryProfileStore(), _Kb(DOCS), FakeProfileClient()
    first = _level(store, kb, fake, model="model-a")
    second = _level(store, kb, fake, model="model-b")
    assert second.version == first.version and second.built_with == "model-a"


def test_a_configured_profile_model_is_used_for_everything(monkeypatch) -> None:
    monkeypatch.setattr(settings, "kb_profile_model", "pinned-model")
    profile = _level(InMemoryProfileStore(), _Kb(DOCS), FakeProfileClient(), model="job-model")
    assert profile.built_with == "pinned-model"


def test_no_knowledge_base_or_a_failing_build_means_the_built_in_rubric_and_only_the_switch_off_means_none(monkeypatch) -> None:
    monkeypatch.setattr(settings, "kb_profile_model", "")
    assert _level(InMemoryProfileStore(), _Kb({}), FakeProfileClient()).source == "default"  # no KB documents: the built-in rubric

    class Broken(_Kb):
        def list_documents(self, user_id):
            raise RuntimeError("chroma down")

    assert _level(InMemoryProfileStore(), Broken(DOCS), FakeProfileClient()).source == "default"  # a failing build never fails the job

    monkeypatch.setattr(settings, "kb_profile_scoring", False)
    assert _level(InMemoryProfileStore(), _Kb(DOCS), FakeProfileClient()) is None  # switched off: as before rubrics


def _client_after_level(store, kb, fake):
    captured: dict = {}

    def fake_build(*args, **kwargs):
        captured.update(kwargs)
        return WorkItemTree(nodes=[], warnings=[])

    with patch("app.main._kb_profile_store", store), patch("app.main._kb_vector_store", kb), \
            patch("app.main._make_profile_client", lambda m: fake), patch("app.main.build_survey_tree", fake_build):
        response = client.post(
            "/level?mode=survey&model=job-model", content=_doc_json(),
            headers={"Content-Type": "application/json", "X-Req2Ado-User-Id": "u1"},
        )
    assert response.status_code == 200, response.text
    return captured["analysis_client"]


def test_item_writing_prompts_get_the_authoring_standard_from_the_profile(monkeypatch) -> None:
    monkeypatch.setattr(settings, "kb_profile_model", "")
    writer = _client_after_level(InMemoryProfileStore(), _Kb(DOCS), FakeProfileClient())
    assert writer.authoring_standard and "Requirement: A verifiable statement of need" in writer.authoring_standard


def test_without_a_kb_or_with_the_generation_switch_off_prompts_are_untouched(monkeypatch) -> None:
    monkeypatch.setattr(settings, "kb_profile_model", "")
    assert _client_after_level(InMemoryProfileStore(), _Kb({}), FakeProfileClient()).authoring_standard is None
    monkeypatch.setattr(settings, "kb_profile_generation", False)
    assert _client_after_level(InMemoryProfileStore(), _Kb(DOCS), FakeProfileClient()).authoring_standard is None


def test_a_build_that_raises_with_a_stored_profile_still_scores_with_it_not_with_the_default(monkeypatch) -> None:
    from app.kb.profile import Category, KbProfile

    monkeypatch.setattr(settings, "kb_profile_model", "")
    store = InMemoryProfileStore()
    store.put("u1", KbProfile(version="v-stored", built_with="m", categories=[Category(name="Testable", pass_condition="Can be verified", sources=["A"], merged_from=["Testable"])]))

    class Broken(_Kb):
        def list_documents(self, user_id):
            raise RuntimeError("chroma down")

    used = _level(store, Broken(DOCS), FakeProfileClient())
    assert used.source == "kb" and used.version == "v-stored" and used.degraded is True
