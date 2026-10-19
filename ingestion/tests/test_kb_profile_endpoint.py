from unittest.mock import patch

from fastapi.testclient import TestClient

from app.kb.profile import InMemoryProfileStore
from app.main import app
from tests.test_kb_profile import DOCS, FakeProfileClient, _Kb

client = TestClient(app)


def _wire(kb_docs: dict[str, str]):
    store = InMemoryProfileStore()
    fake = FakeProfileClient()
    return store, fake, [
        patch("app.main._kb_profile_store", store),
        patch("app.main._kb_vector_store", _Kb(kb_docs)),
        patch("app.main._make_profile_client", lambda model: fake),
    ]


def test_building_returns_the_profile_and_a_second_call_does_not_rebuild() -> None:
    store, fake, patches = _wire(DOCS)
    for p in patches:
        p.start()
    try:
        first = client.post("/kb/profile", json={"user_id": "u1", "model": "m1"})
        assert first.status_code == 200, first.text
        body = first.json()
        assert body["docsInKb"] == 3 and body["docsContributing"] == 3 and body["builtWith"] == "m1"
        assert {c["name"].casefold() for c in body["profile"]["categories"]} == {"clear and unambiguous", "testable", "implementable"}

        calls = len(fake.extract_calls)
        again = client.post("/kb/profile", json={"user_id": "u1", "model": "m1"})
        assert again.json() == body and len(fake.extract_calls) == calls
        assert client.get("/kb/profile", params={"user_id": "u1"}).json() == body
    finally:
        for p in patches:
            p.stop()


def test_an_empty_knowledge_base_has_no_profile() -> None:
    _, _, patches = _wire({})
    for p in patches:
        p.start()
    try:
        assert client.post("/kb/profile", json={"user_id": "u1", "model": "m1"}).status_code == 404
        assert client.get("/kb/profile", params={"user_id": "u1"}).status_code == 404
    finally:
        for p in patches:
            p.stop()


def test_a_model_is_required() -> None:
    assert client.post("/kb/profile", json={"user_id": "u1"}).status_code == 422
