# ingestion/tests/kb/test_sharepoint_status_route.py
from fastapi.testclient import TestClient

from app.kb.graph_client import GraphApiError, GraphClient
from app.main import app

client = TestClient(app)


def test_status_is_not_configured_without_a_users_token_even_with_a_server_token(monkeypatch) -> None:
    """Each user connects their own token (owner finding, 2026-11-26): a token in the environment is never anyone's connection."""
    monkeypatch.setenv("SHAREPOINT_TOKEN", "server-token")
    monkeypatch.setenv("GRAPH_TOKEN", "server-token")

    response = client.post("/kb/sharepoint/status", json={})

    assert response.status_code == 200
    assert response.json() == {"status": "not_configured", "expires_in_seconds": None}


def test_status_checks_the_token_in_the_request(monkeypatch) -> None:
    captured = {}

    def fake_validate(self) -> None:
        captured["token"] = self.token

    monkeypatch.setattr(GraphClient, "validate", fake_validate)

    response = client.post("/kb/sharepoint/status", json={"graph_token": "user-token"})

    assert response.status_code == 200
    assert response.json()["status"] == "valid"
    assert captured["token"] == "user-token"


def test_status_is_invalid_on_a_401_from_graph(monkeypatch) -> None:
    def fake_validate(self) -> None:
        raise GraphApiError(401, "token expired or invalid")

    monkeypatch.setattr(GraphClient, "validate", fake_validate)

    response = client.post("/kb/sharepoint/status", json={"graph_token": "user-token"})

    assert response.status_code == 200
    assert response.json()["status"] == "invalid"


def test_status_is_unreachable_on_a_502_class_graph_failure(monkeypatch) -> None:
    def fake_validate(self) -> None:
        raise GraphApiError(502, "could not reach Microsoft Graph")

    monkeypatch.setattr(GraphClient, "validate", fake_validate)

    response = client.post("/kb/sharepoint/status", json={"graph_token": "user-token"})

    assert response.status_code == 200
    assert response.json()["status"] == "unreachable"
