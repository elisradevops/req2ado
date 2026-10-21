"""What a stored job result depends on besides the file: the ingestion build that made it and the KB profile it was scored with.

The orchestrator keyed its result cache on the release, the file, the model and the KB documents only. An ingestion-only release (0.3.14 to
0.3.15) therefore kept serving the previous build's tree (a rerun came back in 46 s), and a rebuilt profile did not invalidate results scored
with the old categories."""
from importlib import metadata

from fastapi.testclient import TestClient

from app.kb.profile import Category, KbProfile
from app.main import app

client = TestClient(app)


def test_the_scope_names_the_ingestion_build_and_the_stored_profile(monkeypatch) -> None:
    profile = KbProfile(version="v-stored", built_with="m", categories=[Category(name="A", sources=["d"], merged_from=["A"])])
    monkeypatch.setattr("app.main._stored_profile_or_none", lambda user_id: profile)
    body = client.get("/cache-scope", params={"user_id": "u1"}).json()
    assert body == {"ingestion": metadata.version("req2ado-ingestion"), "profile": "v-stored"}


def test_a_user_without_a_profile_has_none(monkeypatch) -> None:
    monkeypatch.setattr("app.main._stored_profile_or_none", lambda user_id: None)
    assert client.get("/cache-scope", params={"user_id": "u1"}).json()["profile"] is None
    assert client.get("/cache-scope").json()["profile"] is None  # no user at all
