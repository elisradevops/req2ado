# ingestion/tests/kb/test_sharepoint_status_route.py
from fastapi.testclient import TestClient

from app.config import settings
from app.kb.graph_client import GraphApiError, GraphClient
from app.main import app

client = TestClient(app)


def test_status_is_not_configured_when_no_token_anywhere(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", None)

    response = client.post("/kb/sharepoint/status", json={})

    assert response.status_code == 200
    assert response.json() == {"status": "not_configured", "expires_in_seconds": None}


def test_status_is_valid_when_graph_accepts_the_env_token(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "env-token")
    monkeypatch.setattr(GraphClient, "validate", lambda self: None)

    response = client.post("/kb/sharepoint/status", json={})

    assert response.status_code == 200
    assert response.json()["status"] == "valid"


def test_status_prefers_the_request_override_token_over_the_env_token(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "env-token")
    captured = {}

    def fake_validate(self) -> None:
        captured["token"] = self.token

    monkeypatch.setattr(GraphClient, "validate", fake_validate)

    response = client.post("/kb/sharepoint/status", json={"graph_token": "override-token"})

    assert response.status_code == 200
    assert captured["token"] == "override-token"


def test_status_is_invalid_on_a_401_from_graph(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "env-token")

    def fake_validate(self) -> None:
        raise GraphApiError(401, "token expired or invalid")

    monkeypatch.setattr(GraphClient, "validate", fake_validate)

    response = client.post("/kb/sharepoint/status", json={})

    assert response.status_code == 200
    assert response.json()["status"] == "invalid"


def test_status_is_unreachable_on_a_502_class_graph_failure(monkeypatch) -> None:
    monkeypatch.setattr(settings, "sharepoint_token", "env-token")

    def fake_validate(self) -> None:
        raise GraphApiError(502, "could not reach Microsoft Graph")

    monkeypatch.setattr(GraphClient, "validate", fake_validate)

    response = client.post("/kb/sharepoint/status", json={})

    assert response.status_code == 200
    assert response.json()["status"] == "unreachable"
