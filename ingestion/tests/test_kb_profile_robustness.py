"""A profile that could not be built properly is never stored as the current one, and a previous profile's decisions survive a bad run.

A model outage (or a caller that disconnected, which cancels the run's model calls) used to leave every extraction and the
consolidation failing; the empty result was stored under the version of the unchanged documents and returned to every later job
until a document changed: all later jobs scored without the knowledge base's standard."""
import pytest

from app.job_cancel import JobCancelled
from app.kb import profile as profile_module
from app.kb.profile import Category, InMemoryProfileStore, KbProfile, build_profile, ensure_profile
from tests.test_kb_profile import FakeProfileClient
from tests.test_kb_profile_consolidation import OVERLAPPING, SEPARATE, Consolidating
from tests.test_kb_profile_cache import Kb


class Failing(Consolidating):
    def extract_kb_document_profile(self, name, window_text, user_id=None):
        raise RuntimeError("model down")


class Cancelled(Consolidating):
    def judge_kb_document_relevance(self, name, excerpt, user_id=None):
        raise JobCancelled("caller gone")

    def extract_kb_document_profile(self, name, window_text, user_id=None):
        raise JobCancelled("caller gone")


@pytest.mark.parametrize("broken", [Failing, Cancelled])
def test_a_build_where_every_document_failed_is_returned_but_not_stored_and_the_next_job_rebuilds(broken) -> None:
    store, kb = InMemoryProfileStore(), Kb(dict(OVERLAPPING))
    degraded = ensure_profile("u1", kb, store, broken(), model="m1")
    assert degraded is not None and degraded.categories == []
    assert store.get("u1") is None  # nothing stored as current

    healthy = ensure_profile("u1", kb, store, Consolidating(), model="m1")
    assert healthy.categories and store.get("u1") == healthy


def test_a_build_where_one_document_failed_is_not_stored_either() -> None:
    class OneFails(Consolidating):
        def extract_kb_document_profile(self, name, window_text, user_id=None):
            if name == "Principles.pptx":
                raise RuntimeError("model down")
            return super().extract_kb_document_profile(name, window_text, user_id=user_id)

    store, kb = InMemoryProfileStore(), Kb(dict(OVERLAPPING))
    partial = ensure_profile("u1", kb, store, OneFails(), model="m1")
    assert any(d.status == "failed" for d in partial.docs) and store.get("u1") is None
    assert ensure_profile("u1", kb, store, Consolidating(), model="m1").docs_contributing == 2


def test_the_documents_that_did_succeed_are_not_extracted_again_on_the_retry() -> None:
    class OneFails(Consolidating):
        def extract_kb_document_profile(self, name, window_text, user_id=None):
            if name == "Principles.pptx":
                raise RuntimeError("model down")
            return super().extract_kb_document_profile(name, window_text, user_id=user_id)

    store, kb, client = InMemoryProfileStore(), Kb(dict(OVERLAPPING)), OneFails()
    ensure_profile("u1", kb, store, client, model="m1")
    ensure_profile("u1", kb, store, client, model="m1")
    assert client.extract_calls.count("HowTo.pptx") == 1  # the cache keeps what was complete


def test_consolidation_that_got_no_answer_at_all_is_not_stored() -> None:
    store, kb = InMemoryProfileStore(), Kb(dict(OVERLAPPING))
    unmerged = ensure_profile("u1", kb, store, Consolidating(fail=True), model="m1")
    assert unmerged.categories and store.get("u1") is None
    merged = ensure_profile("u1", kb, store, Consolidating(), model="m1")
    assert store.get("u1") == merged and len(merged.categories) < len(unmerged.categories)


def test_a_document_with_nothing_to_extract_is_not_a_failure() -> None:
    store, kb = InMemoryProfileStore(), Kb({**OVERLAPPING, "empty.pptx": "nothing useful here"})
    ensure_profile("u1", kb, store, Consolidating(), model="m1")
    assert store.get("u1") is not None


def previous(groups: dict[str, list[str]]) -> KbProfile:
    return KbProfile(
        version="old", built_with="m1",
        categories=[Category(name=n, pass_condition="c", sources=["HowTo.pptx", "Principles.pptx"], merged_from=m) for n, m in groups.items()],
    )


def test_the_previous_groups_and_names_survive_a_build_whose_merge_pass_got_no_answer() -> None:
    prior = previous({"Testability": ["Testable", "Testability"]})
    profile = build_profile(OVERLAPPING, Consolidating(fail=True), model="m1", previous=prior)
    names = sorted(c.name for c in profile.categories)
    assert "Testability" in names and "Testable" not in names
    assert next(c for c in profile.categories if c.name == "Testability").merged_from == ["Testable", "Testability"]


def test_the_previous_groups_survive_a_client_without_a_merge_pass() -> None:
    prior = previous({"Testability": ["Testable", "Testability"]})
    profile = build_profile(OVERLAPPING, FakeProfileClient(), model="m1", previous=prior)
    assert "Testable" not in {c.name for c in profile.categories} and "Testability" in {c.name for c in profile.categories}


def test_every_entry_records_what_it_stands_for_even_without_a_merge_pass() -> None:
    profile = build_profile(OVERLAPPING, FakeProfileClient(), model="m1")
    assert all(c.merged_from == [c.name] for c in profile.categories)


def test_a_refresh_starts_from_the_documents_not_from_earlier_merges() -> None:
    store, kb = InMemoryProfileStore(), Kb(dict(OVERLAPPING))
    ensure_profile("u1", kb, store, Consolidating(), model="m1")  # Testable + Testability merged
    refreshed = ensure_profile("u1", kb, store, Consolidating(runs=[SEPARATE] * 3), model="m1", refresh=True)
    assert {"Testable", "Testability"} <= {c.name for c in refreshed.categories}  # the bad merge can be undone


class FlakyCache:
    """A cache whose store fails: a build already paid for must not be lost to it."""

    def get(self, file, fingerprint):
        raise RuntimeError("chroma down")

    def put(self, file, fingerprint, result):
        raise RuntimeError("chroma down")

    def files(self):
        return []

    def keep_only(self, files):
        raise RuntimeError("chroma down")


def test_a_failing_cache_store_costs_the_cache_not_the_build() -> None:
    profile = build_profile(OVERLAPPING, Consolidating(), model="m1", cache=FlakyCache())
    assert profile.docs_contributing == 2 and profile.categories


def test_a_job_never_scores_with_a_half_built_profile_it_keeps_the_last_good_one_or_the_default(monkeypatch) -> None:
    from app import main

    good = KbProfile(version="v-good", built_with="m1", categories=[Category(name="Testable", sources=["A"], merged_from=["Testable"])])
    broken = KbProfile(version="v-new", built_with="m1", categories=[Category(name="Half", sources=["A"], merged_from=["Half"])], degraded=True)
    store = InMemoryProfileStore()
    monkeypatch.setattr(main, "_kb_profile_store", store)
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: broken)
    monkeypatch.setattr(main.settings, "kb_profile_scoring", True)
    monkeypatch.setattr(main, "_make_profile_client", lambda model: object())

    assert main._profile_for_job("u1", "m1").source == "default"  # nothing good stored: the built-in rubric, not a half-built one
    store.put("u1", good)
    assert main._profile_for_job("u1", "m1") == good  # a good one is stored: keep scoring with it
    monkeypatch.setattr(main, "ensure_profile", lambda *a, **k: KbProfile(version="v2", built_with="m1", categories=[Category(name="Full", sources=["A"], merged_from=["Full"])]))
    assert [c.name for c in main._profile_for_job("u1", "m1").categories] == ["Full"]
