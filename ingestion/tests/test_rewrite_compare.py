"""A rewrite is judged against the original in ONE model call, under the same rubric the job was scored with.

Before, a rescore after an edit used one item alone with KB chunks retrieved for the new text, while the original score came from a
batch of 22 with the profile's context: two scores from two different frames, so a -22 or a +47 could not be told from noise.
Scoring both texts together gives them one frame and one rubric."""
import json

import httpx
from fastapi.testclient import TestClient

from app.kb.profile import build_profile
from app.main import app
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from tests.test_kb_profile import DOCS, FakeProfileClient

client = TestClient(app)
PROFILE = build_profile(DOCS, FakeProfileClient(), model="m1")
CHECKLIST = ["Clear and unambiguous", "Testable"]
KEY = "completeness_as_requirement"
BODY = {
    "original_title": "Lock time", "original_description": "The receiver shall lock within 5 ms at 3.3 V.",
    "proposed_title": None, "proposed_description": "The receiver shall acquire lock within 5 ms when supplied with 3.3 V.",
    "category_checklist": CHECKLIST, "user_id": "u1", "model": "m",
}


def _patch(monkeypatch, handler, profile=PROFILE) -> None:
    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")
    monkeypatch.setattr("app.main._stored_profile_or_none", lambda user_id: profile)
    monkeypatch.setattr("app.main._resolve_caps", lambda *a, **k: type("Caps", (), {"context_budget_tokens": 8000})())


def _scores(before: dict, after: dict, drop: str | None = None) -> httpx.Response:
    entries = {"before": before, "after": after}
    entries.pop(drop, None)
    return httpx.Response(200, json={"content": json.dumps(entries)})


def _entry(score: int, **cats: int) -> dict:
    return {"score": score, "issues": [], "categoryScores": cats}


def test_both_texts_are_scored_in_one_call_with_the_same_rubric_and_the_profile_context(monkeypatch) -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        return _scores(
            _entry(64, **{"Clear and unambiguous": 60, "Testable": 70, KEY: 90}),
            _entry(71, **{"Clear and unambiguous": 80, "Testable": 70, KEY: 90}),
        )

    _patch(monkeypatch, handler)
    response = client.post("/rewrite/compare", json=BODY)

    assert response.status_code == 200, response.text
    assert len(calls) == 1  # one call, one frame
    sent = json.dumps(calls[0])
    assert "One reading only" in sent  # the profile's pass conditions, as in the original scoring
    user = json.loads(calls[0]["messages"][1]["content"])
    assert set(user) >= {"before", "after"} and "acquire lock" in user["after"] and "lock within 5 ms" in user["before"]
    assert '"Clear and unambiguous", "Testable"' in calls[0]["messages"][0]["content"]  # the item's own categories
    body = response.json()
    assert body["before"]["score"] == 64 and body["after"]["score"] == 71 and body["delta"] == 7
    assert body["categoryDeltas"] == {"Clear and unambiguous": 20, "Testable": 0, KEY: 0}
    assert body["warnings"] == []


def test_the_deterministic_warnings_come_with_the_comparison(monkeypatch) -> None:
    _patch(monkeypatch, lambda r: _scores(_entry(64, Testable=60), _entry(40, Testable=40)))
    bad = {**BODY, "proposed_title": "Other title", "proposed_description": "The receiver shall lock quickly."}
    body = client.post("/rewrite/compare", json=bad).json()
    codes = {w["code"] for w in body["warnings"]}
    assert {"title_changed", "dropped_numbers"} <= codes
    assert body["delta"] == -24


def test_when_the_model_cannot_score_both_texts_the_warnings_still_come_back_and_no_delta_is_made_up(monkeypatch) -> None:
    _patch(monkeypatch, lambda r: _scores(_entry(64, Testable=60), _entry(71, Testable=70), drop="after"))
    bad = {**BODY, "proposed_description": "The receiver shall lock quickly."}
    response = client.post("/rewrite/compare", json=bad)
    assert response.status_code == 200
    body = response.json()
    assert body["delta"] is None and body["categoryDeltas"] == {} and body["after"]["score"] is None
    assert "dropped_numbers" in {w["code"] for w in body["warnings"]}  # what can be seen in the texts needs no model


def test_a_failing_model_call_is_the_same_unavailable_comparison_not_an_error(monkeypatch) -> None:
    monkeypatch.setattr("app.survey.orchestrator_llm_client.time.sleep", lambda seconds: None)  # the client's retry backoff
    _patch(monkeypatch, lambda r: httpx.Response(502, json={"detail": "upstream"}))
    response = client.post("/rewrite/compare", json={**BODY, "proposed_title": "Other title"})
    assert response.status_code == 200
    body = response.json()
    assert body["delta"] is None and body["before"]["score"] is None and body["after"]["score"] is None
    assert "title_changed" in {w["code"] for w in body["warnings"]}


def test_blank_texts_are_refused(monkeypatch) -> None:
    _patch(monkeypatch, lambda r: _scores(_entry(1), _entry(2)))
    assert client.post("/rewrite/compare", json={**BODY, "proposed_description": "  "}).status_code == 400
    assert client.post("/rewrite/compare", json={**BODY, "original_description": ""}).status_code == 400


def test_score_item_uses_the_profile_context_not_retrieved_chunks(monkeypatch) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.dumps(json.loads(request.content)))
        return httpx.Response(200, json={"content": json.dumps({"adhoc": _entry(70, **{"Clear and unambiguous": 70})})})

    _patch(monkeypatch, handler)

    def boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("retrieved chunks must not be used when the user has a profile")

    monkeypatch.setattr("app.main.retrieve_context", boom)
    response = client.post("/score-item", json={"description": "The system shall be fast.", "user_id": "u1", "category_checklist": CHECKLIST})
    assert response.status_code == 200
    assert "One reading only" in seen[0]


def test_score_item_without_a_profile_keeps_retrieving(monkeypatch) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.dumps(json.loads(request.content)))
        return httpx.Response(200, json={"content": json.dumps({"adhoc": _entry(70, clarity=70)})})

    _patch(monkeypatch, handler, profile=None)
    monkeypatch.setattr("app.main.retrieve_context", lambda *a, **k: ("RETRIEVED CHUNK", []))
    client.post("/score-item", json={"description": "The system shall be fast.", "user_id": "u1"})
    assert "RETRIEVED CHUNK" in seen[0]


def test_the_off_switch_for_profile_scoring_also_governs_a_rescore_and_a_comparison(monkeypatch) -> None:
    # With KB_PROFILE_SCORING off a job scores with retrieved chunks; a rescore must use the same frame, not the profile.
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.dumps(json.loads(request.content)))
        return _scores(_entry(64, Testable=60), _entry(71, Testable=70))

    _patch(monkeypatch, handler)
    monkeypatch.setattr("app.main.settings.kb_profile_scoring", False)
    monkeypatch.setattr("app.main.retrieve_context", lambda *a, **k: ("RETRIEVED CHUNK", []))
    client.post("/rewrite/compare", json={**BODY, "category_checklist": None})
    client.post("/score-item", json={"description": "The system shall be fast.", "user_id": "u1"})
    assert all("RETRIEVED CHUNK" in text and "One reading only" not in text for text in seen)


def test_warnings_only_answers_at_once_without_calling_the_model(monkeypatch) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return _scores(_entry(1), _entry(2))

    _patch(monkeypatch, handler)
    body = client.post("/rewrite/compare", json={**BODY, "proposed_title": "Other", "proposed_description": "The receiver shall lock quickly.", "warnings_only": True}).json()
    assert calls == []
    assert body["delta"] is None and body["before"]["score"] is None
    assert {"title_changed", "dropped_numbers"} <= {w["code"] for w in body["warnings"]}


def test_a_prediction_that_takes_longer_than_the_cap_gives_the_warnings_and_no_score_and_stops_asking(monkeypatch) -> None:
    import time

    calls: list[int] = []

    def slow(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        time.sleep(0.8)
        return _scores(_entry(64, Testable=60), _entry(71, Testable=70))

    _patch(monkeypatch, slow)
    monkeypatch.setattr("app.main.REWRITE_PREDICTION_SECONDS", 0.2)
    started = time.monotonic()
    response = client.post("/rewrite/compare", json={**BODY, "proposed_description": "The receiver shall lock quickly."})
    elapsed = time.monotonic() - started

    assert response.status_code == 200 and elapsed < 0.7  # did not wait for the slow model
    body = response.json()
    assert body["delta"] is None and body["before"]["score"] is None
    assert "dropped_numbers" in {w["code"] for w in body["warnings"]}
    time.sleep(1.0)  # the call already in flight finishes; the cancelled run must not start another
    assert len(calls) == 1


def test_a_prediction_within_the_cap_is_returned_as_before(monkeypatch) -> None:
    _patch(monkeypatch, lambda r: _scores(_entry(64, Testable=60), _entry(71, Testable=70)))
    monkeypatch.setattr("app.main.REWRITE_PREDICTION_SECONDS", 5)
    assert client.post("/rewrite/compare", json=BODY).json()["delta"] == 7
