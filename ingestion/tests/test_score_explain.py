"""'Why this score?': the reason for each low category, on demand, from the rubric the item was graded against.

A category score was a bare number: nothing said which part of the item missed which pass condition, or what to change. The explanation is a
separate, cheap call made when the user asks (putting reasons into every scoring run would make every job slower), based on the knowledge
base's pass conditions when there is a KB, and otherwise on the built-in rubric and its design philosophy (what an Epic, a Feature and a
Requirement are, and what makes a requirement good)."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.kb.default_rubric import default_profile
from app.kb.profile import Category, KbProfile
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

client = TestClient(main.app)
SCORES = {"Necessary": 90, "Unambiguous": 35, "Singular": 50, "Verifiable": 20, "Complete": 65, "Implementation-free": 80, "Consistent": 75, "Traceable": 69}
BODY = {
    "title": "Lock time", "description": "The receiver shall lock fast and be user-friendly.", "category_scores": SCORES, "user_id": "u1", "model": "m",
    "context": {"documentName": "AirPro.docx", "parents": [{"type": "Feature", "title": "Carrier acquisition", "description": "How lock is found."}]},
}


def install(monkeypatch, handler, profile=None) -> None:
    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")
    monkeypatch.setattr("app.main._stored_profile_or_none", lambda user_id: profile if profile is not None else default_profile())
    monkeypatch.setattr("app.main._resolve_caps", lambda *a, **k: type("Caps", (), {"context_budget_tokens": 8000})())


class Recorder:
    def __init__(self, reasons: dict[str, str] | None = None) -> None:
        self.calls: list[dict] = []
        self.reasons = reasons

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.calls.append(body)
        asked = [c["name"] for c in json.loads(body["messages"][1]["content"])["categories"]]
        reasons = self.reasons if self.reasons is not None else {n: f"Reason for {n}." for n in asked}
        return httpx.Response(200, json={"content": json.dumps({"explanations": [{"category": n, "reason": reasons[n]} for n in asked if n in reasons]})})


def asked_names(recorder: Recorder) -> list[str]:
    return [c["name"] for c in json.loads(recorder.calls[0]["messages"][1]["content"])["categories"]]


def test_the_weakest_categories_are_explained_in_one_call_weakest_first_at_most_five(monkeypatch) -> None:
    recorder = Recorder()
    install(monkeypatch, recorder)
    response = client.post("/score-explain", json=BODY)
    assert response.status_code == 200, response.text
    assert len(recorder.calls) == 1
    assert asked_names(recorder) == ["Verifiable", "Unambiguous", "Singular", "Complete", "Traceable"]  # the five below 70, weakest first
    body = response.json()
    assert [e["category"] for e in body["explanations"]] == ["Verifiable", "Unambiguous", "Singular", "Complete", "Traceable"]
    assert body["explanations"][0] == {
        "category": "Verifiable", "score": 20, "reason": "Reason for Verifiable.",
        "passCondition": next(c.pass_condition for c in default_profile().categories if c.name == "Verifiable"),
    }


def test_without_a_knowledge_base_the_built_in_rubric_and_its_design_philosophy_are_the_basis(monkeypatch) -> None:
    recorder = Recorder()
    install(monkeypatch, recorder)
    body = client.post("/score-explain", json=BODY).json()
    system = recorder.calls[0]["messages"][0]["content"]
    assert "29148" in system and "Epic" in system and "built-in" in system.lower()
    assert body["basis"] == "built_in" and body["rubric"]["source"] == "default"
    user = json.loads(recorder.calls[0]["messages"][1]["content"])
    assert user["categories"][0]["guidance"]  # how to improve, from the built-in rubric
    assert "Carrier acquisition" in json.dumps(user["context"]) or "Carrier acquisition" in json.dumps(user)  # the bigger context


def test_with_a_knowledge_base_its_own_pass_conditions_are_the_basis_and_the_philosophy_is_left_out(monkeypatch) -> None:
    kb = KbProfile(version="v-kb", built_with="m", categories=[
        Category(name="Testability", pass_condition="Verified by a named test method", sources=["A.pptx"], merged_from=["Testability"]),
        Category(name="Clarity", pass_condition="One reading only", sources=["A.pptx"], merged_from=["Clarity"]),
    ])
    recorder = Recorder()
    install(monkeypatch, recorder, kb)
    body = client.post("/score-explain", json={**BODY, "category_scores": {"Testability": 30, "Clarity": 55}}).json()
    system = recorder.calls[0]["messages"][0]["content"]
    assert "organization's own" in system and "29148" not in system
    user = json.loads(recorder.calls[0]["messages"][1]["content"])
    assert user["categories"][0] == {"name": "Testability", "score": 30, "pass_condition": "Verified by a named test method", "guidance": None}
    assert body["basis"] == "knowledge_base" and body["rubric"] == {"source": "kb", "version": "v-kb"}


def test_a_pinned_pass_condition_is_what_the_explanation_holds_the_item_to(monkeypatch) -> None:
    from app.kb.rubric import RubricOverrides, RubricPin, apply_overrides

    pinned = apply_overrides(default_profile(), RubricOverrides(pinned=[RubricPin(name="Verifiable", pass_condition="Has an acceptance test id")]))
    recorder = Recorder()
    install(monkeypatch, recorder, pinned)
    client.post("/score-explain", json=BODY)
    user = json.loads(recorder.calls[0]["messages"][1]["content"])
    assert next(c for c in user["categories"] if c["name"] == "Verifiable")["pass_condition"] == "Has an acceptance test id"


def test_the_user_can_ask_about_chosen_categories_and_a_name_the_rubric_no_longer_has_is_still_answered(monkeypatch) -> None:
    recorder = Recorder()
    install(monkeypatch, recorder)
    client.post("/score-explain", json={**BODY, "categories": ["Consistent", "An old category"], "category_scores": {**SCORES, "An old category": 10}})
    assert asked_names(recorder) == ["Consistent", "An old category"]
    old = json.loads(recorder.calls[0]["messages"][1]["content"])["categories"][1]
    assert old["pass_condition"] is None and old["score"] == 10


def test_an_item_with_no_weak_category_still_gets_its_two_lowest_explained(monkeypatch) -> None:
    recorder = Recorder()
    install(monkeypatch, recorder)
    client.post("/score-explain", json={**BODY, "category_scores": {"Necessary": 95, "Singular": 88, "Verifiable": 91}})
    assert asked_names(recorder) == ["Singular", "Verifiable"]


def test_a_reason_is_kept_short_and_a_category_the_model_skipped_has_none(monkeypatch) -> None:
    recorder = Recorder({"Verifiable": "x" * 900})
    install(monkeypatch, recorder)
    explanations = {e["category"]: e for e in client.post("/score-explain", json=BODY).json()["explanations"]}
    assert len(explanations["Verifiable"]["reason"]) <= 300
    assert explanations["Unambiguous"]["reason"] is None


def test_the_request_carries_the_item_and_never_asks_for_a_rewrite(monkeypatch) -> None:
    recorder = Recorder()
    install(monkeypatch, recorder)
    client.post("/score-explain", json=BODY)
    user = json.loads(recorder.calls[0]["messages"][1]["content"])
    assert user["item"]["description"] == BODY["description"] and user["item"]["title"] == "Lock time"
    assert "propos" not in recorder.calls[0]["messages"][0]["content"].lower()  # it explains; it does not rewrite


def test_blank_text_is_refused_and_a_failing_model_is_a_502(monkeypatch) -> None:
    install(monkeypatch, Recorder())
    assert client.post("/score-explain", json={**BODY, "description": "  "}).status_code == 400
    monkeypatch.setattr("app.survey.orchestrator_llm_client.time.sleep", lambda seconds: None)
    install(monkeypatch, lambda request: httpx.Response(502, json={"detail": "upstream"}))
    response = client.post("/score-explain", json=BODY)
    assert response.status_code == 502


def test_a_model_that_takes_too_long_is_a_504_and_the_run_is_cancelled_so_it_asks_no_further(monkeypatch) -> None:
    import threading
    import time
    from contextlib import contextmanager

    from app import job_cancel

    tokens: list = []
    real_scope = job_cancel.cancellation_scope

    @contextmanager
    def recording_scope():
        with real_scope() as token:
            tokens.append(token)
            yield token

    def slow(request: httpx.Request) -> httpx.Response:
        threading.Event().wait(0.6)
        return httpx.Response(200, json={"content": json.dumps({"explanations": []})})

    install(monkeypatch, slow)
    monkeypatch.setattr("app.main.job_cancel.cancellation_scope", recording_scope)
    monkeypatch.setattr("app.main.EXPLAIN_SECONDS", 0.2)
    started = time.monotonic()
    response = client.post("/score-explain", json=BODY)
    assert response.status_code == 504 and time.monotonic() - started < 0.55
    assert len(tokens) == 1 and tokens[0].cancelled is True  # every model call this run would still make now raises at once


def test_an_answer_that_is_not_the_expected_shape_is_a_502(monkeypatch) -> None:
    install(monkeypatch, lambda request: httpx.Response(200, json={"content": json.dumps({"nope": 1})}))
    assert client.post("/score-explain", json=BODY).status_code == 502


def _record_request_timeouts(monkeypatch) -> list:
    timeouts: list = []
    real = httpx.Client

    class Recording(real):
        def __init__(self, *args, **kwargs):
            timeouts.append(kwargs.get("timeout"))
            super().__init__(*args, **kwargs)

    monkeypatch.setattr("app.survey.orchestrator_llm_client.httpx.Client", Recording)
    return timeouts


def test_the_explanation_waits_up_to_two_minutes_and_its_model_call_ends_with_the_cap_instead_of_running_on(monkeypatch) -> None:
    # The first real click took 97 s and got a 504 at 60 s; the model call then ran on for 37 s with its answer thrown away.
    assert main.EXPLAIN_SECONDS == 120
    timeouts = _record_request_timeouts(monkeypatch)
    install(monkeypatch, Recorder())
    assert client.post("/score-explain", json=BODY).status_code == 200
    assert timeouts and set(timeouts) == {main.EXPLAIN_SECONDS + 5}


def test_the_model_must_name_the_items_language_before_writing_reasons_and_is_told_to_use_it(monkeypatch) -> None:
    # Opus answered an English item in Spanish in 5 of 6 replays although the prompt said "write in the language of the item":
    # a one-line instruction in a long prompt is easy to lose. The answer now has to START with the language the item is written in
    # (the model commits to it before writing a reason), the request repeats it, and the prompt ties every reason to it.
    recorder = Recorder()
    install(monkeypatch, recorder)
    client.post("/score-explain", json=BODY)
    call = recorder.calls[0]
    schema = call["responseSchema"]["schema"]
    assert list(schema["properties"])[0] == "language"
    assert schema["required"][0] == "language"
    user = json.loads(call["messages"][1]["content"])
    assert "language" in user["reasons_language"].lower() and "description" in user["reasons_language"].lower()
    system = call["messages"][0]["content"]
    assert '"language"' in system and "every reason" in system.lower()


def test_an_answer_without_the_language_field_is_still_accepted(monkeypatch) -> None:
    # The field steers the model; a model that leaves it out must not turn a usable explanation into a 502.
    recorder = Recorder()
    install(monkeypatch, recorder)
    response = client.post("/score-explain", json=BODY)
    assert response.status_code == 200
