# ingestion/tests/test_health.py
from fastapi.testclient import TestClient

import app.main as main
from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_ready_returns_200_when_both_stores_are_reachable(monkeypatch) -> None:
    monkeypatch.setattr(main._vector_store, "ping", lambda: True)
    monkeypatch.setattr(main._kb_vector_store, "ping", lambda: True)
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "chroma": True, "kbChroma": True}


def test_ready_returns_503_when_chroma_is_unreachable(monkeypatch) -> None:
    # Regression: /health previously never checked Chroma reachability at
    # all -- an unconditional {ok: True} regardless of dependency state.
    monkeypatch.setattr(main._vector_store, "ping", lambda: False)
    monkeypatch.setattr(main._kb_vector_store, "ping", lambda: True)
    response = client.get("/ready")
    assert response.status_code == 503
    assert response.json() == {"ok": False, "chroma": False, "kbChroma": True}


def test_ready_returns_503_when_kb_chroma_is_unreachable(monkeypatch) -> None:
    # Real gap this closes: an outage of the KB store (every SURVEY job's
    # grounding depends on it) previously had no healthcheck at all -- a
    # completed job with silently-empty KB context was indistinguishable
    # from "no KB attached" from the outside.
    monkeypatch.setattr(main._vector_store, "ping", lambda: True)
    monkeypatch.setattr(main._kb_vector_store, "ping", lambda: False)
    response = client.get("/ready")
    assert response.status_code == 503
    assert response.json() == {"ok": False, "chroma": True, "kbChroma": False}
