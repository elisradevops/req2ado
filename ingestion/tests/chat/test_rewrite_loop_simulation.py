"""The whole 'improve this' loop, simulated without a model: a rule-based judge, scripted chat rewrites, the real route.

The judge is a stand-in for the rubric's known penalties (bundled statements, length, vague words, a missing figure), not a
model. What is asserted is the property the user relies on: a rewrite that makes the item worse never gets through as 'predicted
better, nothing flagged' (the 64 -> 42 case), and a faithful improvement is not held up.

The confirmation rule here is the one ChatPanel implements (predicted drop, or a `high` warning)."""
import json
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import RewriteCompareRequest, app
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

client = TestClient(app)
ORIGINAL = "The receiver shall lock onto the carrier within 5 ms at 3.3 V per MIL-STD-461G."
CHECKLIST = ["Clear and unambiguous", "Testable"]

REWRITES = {
    "faithful": ("The receiver shall acquire carrier lock within 5 ms when supplied with 3.3 V, as required by MIL-STD-461G.", None),
    "bundled_and_long": (
        ORIGINAL + " The receiver shall report loss of lock within 2 ms. The receiver shall retry acquisition up to three times. "
        "Rationale: fast lock keeps the downstream filter settled, which matters because the filter is slow. Acceptance: verified by "
        "test with a calibrated source at several temperatures. The receiver shall log every attempt with its duration and the voltage.",
        None,
    ),
    "drops_the_numbers": ("The receiver shall lock quickly and reliably.", None),
    "new_title_only_otherwise_faithful": (ORIGINAL, "Receiver acquisition behaviour"),
    "vaguer": ("The receiver shall lock fast, user-friendly and as soon as reasonably possible.", None),
}


def judge(text: str) -> dict:
    """A deterministic stand-in for the rubric: what the scoring prompt penalises, as rules."""
    modals = len(re.findall(r"\b(?:shall|should|must)\b", text, re.IGNORECASE))
    vague = len(re.findall(r"\b(?:fast|quickly|reliably|user-friendly|reasonably possible|as soon as)\b", text, re.IGNORECASE))
    has_number = bool(re.search(r"\d", text))
    clear = max(0, 90 - 10 * vague - 10 * max(0, modals - 1) - max(0, len(text) - 200) // 20)
    testable = max(0, (85 if has_number else 40) - 12 * max(0, modals - 1) - 15 * vague)
    return {"score": (clear + testable) // 2, "issues": [], "categoryScores": {"Clear and unambiguous": clear, "Testable": testable, "completeness_as_requirement": 90}}


def needs_confirmation(body: dict) -> bool:
    """ChatPanel's rule."""
    return (body["delta"] is not None and body["delta"] < 0) or any(w["severity"] == "high" for w in body["warnings"])


def _install(monkeypatch, judge_fn) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["messages"][1]["content"]
        parsed = json.loads(texts)
        return httpx.Response(200, json={"content": json.dumps({key: judge_fn(value) for key, value in parsed.items()})})

    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")
    monkeypatch.setattr("app.main._stored_profile_or_none", lambda user_id: None)
    monkeypatch.setattr("app.main._resolve_caps", lambda *a, **k: type("Caps", (), {"context_budget_tokens": 8000})())
    monkeypatch.setattr("app.main.retrieve_context", lambda *a, **k: (None, []))


@pytest.fixture
def judged(monkeypatch):
    _install(monkeypatch, judge)


@pytest.fixture
def flattering(monkeypatch):
    """A judge that scores every text the same and high: the prediction can never be what catches a bad rewrite."""
    _install(monkeypatch, lambda text: {"score": 90, "issues": [], "categoryScores": {"Clear and unambiguous": 90, "Testable": 90, "completeness_as_requirement": 90}})


def compare(name: str) -> dict:
    description, title = REWRITES[name]
    response = client.post("/rewrite/compare", json={
        "original_title": "Lock time", "original_description": ORIGINAL, "proposed_title": title, "proposed_description": description,
        "category_checklist": CHECKLIST, "user_id": "u1", "model": "m",
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_a_faithful_rewrite_is_not_held_up(judged) -> None:
    body = compare("faithful")
    assert body["warnings"] == [] and not needs_confirmation(body)


@pytest.mark.parametrize("name", ["bundled_and_long", "drops_the_numbers", "vaguer"])
def test_a_rewrite_that_makes_the_item_worse_always_asks_for_confirmation(judged, name) -> None:
    body = compare(name)
    assert needs_confirmation(body), body


@pytest.mark.parametrize("name", sorted(REWRITES))
def test_no_rewrite_is_both_predicted_better_and_flagged_clean_while_actually_worse(judged, name) -> None:
    body = compare(name)
    description, _title = REWRITES[name]
    actually_worse = judge(description)["score"] < judge(ORIGINAL)["score"]
    if actually_worse:
        assert needs_confirmation(body), (name, body)


@pytest.mark.parametrize("name", ["bundled_and_long", "drops_the_numbers"])
def test_content_loss_is_caught_by_the_warnings_alone_even_when_the_model_likes_the_rewrite(flattering, name) -> None:
    body = compare(name)
    assert body["delta"] == 0  # the judge sees no difference
    assert needs_confirmation(body), body


def test_a_new_title_alone_is_a_notice_and_does_not_hold_up_an_otherwise_faithful_rewrite(judged) -> None:
    body = compare("new_title_only_otherwise_faithful")
    assert [w["code"] for w in body["warnings"]] == ["title_changed"] and not needs_confirmation(body)


def test_both_texts_are_judged_in_the_same_call_so_the_delta_is_exactly_the_difference(judged) -> None:
    body = compare("faithful")
    assert body["before"]["score"] == judge(ORIGINAL)["score"]
    assert body["after"]["score"] == judge(REWRITES["faithful"][0])["score"]
    assert body["delta"] == body["after"]["score"] - body["before"]["score"]


# ---- the contract between the three services ----

def test_the_request_fields_are_the_ones_the_orchestrator_client_sends() -> None:
    # orchestrator/test/ingestion-http.client.spec.ts pins the same list from the other side.
    assert set(RewriteCompareRequest.model_fields) == {
        "original_title", "original_description", "proposed_title", "proposed_description", "category_checklist", "user_id", "model",
    }


def test_the_response_has_what_the_orchestrator_and_the_frontend_read(judged) -> None:
    body = compare("faithful")
    assert {"before", "after", "delta", "categoryDeltas", "warnings"} <= set(body)
    assert {"score", "issues", "categoryScores", "confidence"} <= set(body["before"])
