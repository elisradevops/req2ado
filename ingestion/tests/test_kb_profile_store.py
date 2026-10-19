import pytest

from app.kb.kb_vector_store import KbVectorStore
from app.kb.profile import ChromaProfileStore, InMemoryProfileStore, KbProfile, build_profile
from tests.test_kb_profile import DOCS, FakeProfileClient


@pytest.fixture
def kb_store(tmp_path):
    return KbVectorStore(str(tmp_path / "chroma"))


def test_a_profile_is_stored_per_user_and_survives_a_new_store_instance(tmp_path) -> None:
    path = str(tmp_path / "chroma")
    profile = build_profile(DOCS, FakeProfileClient(), model="m1")
    ChromaProfileStore(KbVectorStore(path)).put("user-a", profile)

    reopened = ChromaProfileStore(KbVectorStore(path))
    assert reopened.get("user-a") == profile
    assert reopened.get("user-b") is None


def test_putting_again_replaces_the_stored_profile(kb_store) -> None:
    store = ChromaProfileStore(kb_store)
    first = build_profile(DOCS, FakeProfileClient(), model="m1")
    second = build_profile({"only.pptx": "CAT: Solo | alone"}, FakeProfileClient(), model="m1")
    store.put("u", first)
    store.put("u", second)
    assert store.get("u") == second


def test_a_corrupt_stored_profile_reads_as_missing_so_it_is_rebuilt(kb_store) -> None:
    store = ChromaProfileStore(kb_store)
    kb_store.put_profile_json("u", "{not a profile", "v")
    assert store.get("u") is None


def test_purging_a_user_also_removes_the_profile(kb_store) -> None:
    store = ChromaProfileStore(kb_store)
    store.put("u", build_profile(DOCS, FakeProfileClient(), model="m1"))
    kb_store.purge_user("u")
    assert store.get("u") is None


def test_both_stores_satisfy_the_same_contract() -> None:
    profile = build_profile(DOCS, FakeProfileClient(), model="m1")
    memory = InMemoryProfileStore()
    memory.put("u", profile)
    assert isinstance(memory.get("u"), KbProfile)
