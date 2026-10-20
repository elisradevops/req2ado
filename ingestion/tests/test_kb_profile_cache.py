"""A document's extraction is stored and reused, so a rebuild (a document added, the profile asked again) re-reads only what changed.

The extraction is a temperature-1 sample: without this, every rebuild re-sampled every document and the category names the
documents "wrote" drifted from build to build (12, 13 and 14 categories from the same three documents)."""
from app.kb import profile as profile_module
from app.kb.kb_vector_store import KbVectorStore
from app.kb.profile import ChromaProfileStore, InMemoryProfileStore, build_profile, ensure_profile
from tests.test_kb_profile import FakeProfileClient

DOCS = {
    "A.pptx": "CAT: Testable | Can be verified\nRULE: One requirement per statement",
    "B.pptx": "CAT: Unambiguity | One reading only",
}


class DriftingClient(FakeProfileClient):
    """Every extraction answers differently, like a sampled model: a reused result is the only way to get the same names twice."""

    def __init__(self) -> None:
        super().__init__()
        self.n = 0

    def extract_kb_document_profile(self, name, window_text, user_id=None):
        self.extract_calls.append(name)
        self.n += 1
        return {"categories": [{"name": f"{name[0]} variant {self.n}", "pass_condition": "c"}], "rules": [], "type_definitions": [], "glossary": []}


class Kb:
    def __init__(self, docs) -> None:
        self.docs = docs

    def list_documents(self, user_id):
        return sorted(self.docs)

    def get_document(self, user_id, name):
        return self.docs[name], False


def names(profile) -> list[str]:
    return sorted(c.name for c in profile.categories)


def test_an_unchanged_document_is_not_extracted_again_and_keeps_its_categories() -> None:
    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    first = ensure_profile("u1", kb, store, client, model="m1")
    kb.docs["C.pptx"] = "CAT: Complete | Whole"  # a new document makes the profile stale
    second = ensure_profile("u1", kb, store, client, model="m1")
    assert [c for c in client.extract_calls].count("A.pptx") == 1 and client.extract_calls.count("B.pptx") == 1
    assert client.extract_calls.count("C.pptx") == 1
    assert {"A variant 1", "B variant 2"} <= set(names(second))  # what the unchanged documents said the first time
    assert first.version != second.version


def test_a_changed_document_is_extracted_again_the_others_are_not() -> None:
    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    ensure_profile("u1", kb, store, client, model="m1")
    kb.docs["A.pptx"] += "\nCAT: Added | x"
    ensure_profile("u1", kb, store, client, model="m1")
    assert client.extract_calls.count("A.pptx") == 2 and client.extract_calls.count("B.pptx") == 1


def test_a_different_model_extracts_everything_again() -> None:
    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    ensure_profile("u1", kb, store, client, model="m1")
    ensure_profile("u1", kb, store, client, model="m2")
    assert client.extract_calls.count("A.pptx") == 2 and client.extract_calls.count("B.pptx") == 2


def test_a_change_to_the_extraction_itself_invalidates_the_cache(monkeypatch) -> None:
    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    ensure_profile("u1", kb, store, client, model="m1")
    monkeypatch.setattr(profile_module, "WINDOW_CHARS", profile_module.WINDOW_CHARS + 1)  # the reading of a document changed
    kb.docs["C.pptx"] = "CAT: Complete | Whole"
    ensure_profile("u1", kb, store, client, model="m1")
    assert client.extract_calls.count("A.pptx") == 2


def test_only_complete_results_are_stored() -> None:
    long_with_a_failing_window = "CAT: Fine | f\n" + "x" * (profile_module.WINDOW_CHARS + 200) + "\nBOOM"
    docs = {"ok.pptx": "CAT: Testable | t", "boom.pptx": "BOOM", "partial.pptx": long_with_a_failing_window, "empty.pptx": "nothing useful here"}
    store, client, kb = InMemoryProfileStore(), FakeProfileClient(), Kb(dict(docs))
    ensure_profile("u1", kb, store, client, model="m1")
    first_round = {n: client.extract_calls.count(n) for n in docs}
    kb.docs["new.pptx"] = "CAT: New | n"
    ensure_profile("u1", kb, store, client, model="m1")
    again = {n: client.extract_calls.count(n) - first_round[n] for n in docs}
    assert again["ok.pptx"] == 0  # complete: reused
    assert again["boom.pptx"] > 0 and again["partial.pptx"] > 0 and again["empty.pptx"] > 0  # failed, partly failed, empty: tried again


def test_a_verdict_of_not_relevant_is_remembered_but_a_failed_verdict_is_not() -> None:
    docs = {"weather.pptx": "IRRELEVANT\nCAT: X | x", "ok.pptx": "CAT: Testable | t"}
    store, client, kb = InMemoryProfileStore(), FakeProfileClient(), Kb(docs)
    ensure_profile("u1", kb, store, client, model="m1")
    kb.docs["more.pptx"] = "CAT: More | m"
    ensure_profile("u1", kb, store, client, model="m1")
    assert client.relevance_calls.count("weather.pptx") == 1  # not asked again

    flaky = FakeProfileClient(flaky_relevance=True)
    store2, kb2 = InMemoryProfileStore(), Kb({"ok.pptx": "CAT: Testable | t"})
    ensure_profile("u2", kb2, store2, flaky, model="m1")
    kb2.docs["more.pptx"] = "CAT: More | m"
    ensure_profile("u2", kb2, store2, flaky, model="m1")
    assert flaky.relevance_calls.count("ok.pptx") == 2  # the judgement failed, so nothing was stored for it


def test_a_refresh_ignores_what_is_stored_and_replaces_it() -> None:
    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    ensure_profile("u1", kb, store, client, model="m1")
    kb.docs["C.pptx"] = "CAT: Complete | Whole"
    refreshed = ensure_profile("u1", kb, store, client, model="m1", refresh=True)
    assert client.extract_calls.count("A.pptx") == 2
    ensure_profile("u1", Kb({**kb.docs, "D.pptx": "CAT: D | d"}), store, client, model="m1")
    assert client.extract_calls.count("A.pptx") == 2  # the refreshed extraction is what is reused afterwards
    assert "A variant" in "".join(names(refreshed))


def test_a_deleted_document_leaves_nothing_behind() -> None:
    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    ensure_profile("u1", kb, store, client, model="m1")
    del kb.docs["B.pptx"]
    ensure_profile("u1", kb, store, client, model="m1")
    assert sorted(store.document_cache("u1").files()) == ["A.pptx"]


def test_the_cache_survives_a_restart_and_is_dropped_with_the_users_knowledge_base(tmp_path) -> None:
    path = str(tmp_path / "chroma")
    client, kb = DriftingClient(), Kb(dict(DOCS))
    ensure_profile("u1", kb, ChromaProfileStore(KbVectorStore(path)), client, model="m1")
    kb.docs["C.pptx"] = "CAT: Complete | Whole"
    ensure_profile("u1", kb, ChromaProfileStore(KbVectorStore(path)), client, model="m1")  # a new process: new store objects
    assert client.extract_calls.count("A.pptx") == 1

    purged = KbVectorStore(path)
    purged.purge_user("u1")
    assert ChromaProfileStore(purged).document_cache("u1").files() == []


def test_cache_entries_of_different_users_are_separate() -> None:
    client = DriftingClient()
    store = InMemoryProfileStore()
    ensure_profile("u1", Kb(dict(DOCS)), store, client, model="m1")
    ensure_profile("u2", Kb(dict(DOCS)), store, client, model="m1")
    assert client.extract_calls.count("A.pptx") == 2  # u2 never reads u1's extraction


def test_a_build_log_line_says_how_many_documents_came_from_the_cache(caplog) -> None:
    import logging

    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    ensure_profile("u1", kb, store, client, model="m1")
    kb.docs["C.pptx"] = "CAT: Complete | Whole"
    with caplog.at_level(logging.INFO, logger="app.kb.profile"):
        ensure_profile("u1", kb, store, client, model="m1")
    line = next(r.getMessage() for r in caplog.records if "KB profile built" in r.getMessage())
    assert "cached_documents=2" in line


def test_build_profile_without_a_cache_behaves_as_before() -> None:
    client = FakeProfileClient()
    build_profile(DOCS, client, model="m1")
    build_profile(DOCS, client, model="m1")
    assert client.extract_calls.count("A.pptx") == 2


def test_a_refresh_rebuilds_even_when_nothing_changed() -> None:
    store, client, kb = InMemoryProfileStore(), DriftingClient(), Kb(dict(DOCS))
    first = ensure_profile("u1", kb, store, client, model="m1")
    unchanged = ensure_profile("u1", kb, store, client, model="m1")
    assert unchanged == first and client.extract_calls.count("A.pptx") == 1
    refreshed = ensure_profile("u1", kb, store, client, model="m1", refresh=True)
    assert client.extract_calls.count("A.pptx") == 2 and refreshed.built_at != first.built_at


def test_the_route_passes_refresh_on() -> None:
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.main import app

    seen = {}

    def fake(user_id, kb, store, client, *, model, refresh=False):
        seen["refresh"], seen["model"] = refresh, model
        return None

    with patch("app.main.ensure_profile", side_effect=fake):
        assert TestClient(app).post("/kb/profile", json={"user_id": "u", "model": "m", "refresh": True}).status_code == 404
        assert seen == {"refresh": True, "model": "m"}
        TestClient(app).post("/kb/profile", json={"user_id": "u", "model": "m"})
        assert seen["refresh"] is False
