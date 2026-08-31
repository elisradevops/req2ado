import json

import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

client = TestClient(app)


def _patch_llm(monkeypatch, handler) -> None:
    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, cache=None):
        original_init(self, base_url, bearer_token, model=model)
        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")


def test_score_item_returns_the_parsed_score_issues_and_category_scores(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        content = json.dumps(
            {"adhoc": {"score": 65, "issues": ["vague_term"], "categoryScores": {"clarity": 40}}},
        )
        return httpx.Response(200, json={"content": content})

    _patch_llm(monkeypatch, handler)

    response = client.post("/score-item", json={"description": "The system shall be fast."})

    assert response.status_code == 200
    body = response.json()
    assert body["quality_score"] == 65
    assert body["quality_issues"] == ["vague_term"]
    assert body["quality_category_scores"] == {"clarity": 40}


def test_score_item_forces_the_supplied_category_checklist_as_the_exact_key_set(
    monkeypatch,
) -> None:
    # The determinism guarantee this whole feature depends on: a rescore
    # must be judged against the SAME rubric as the original score, not
    # whatever the model would derive live -- see
    # score_single_requirement_text's own docstring.
    captured_system_prompts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured_system_prompts.append(body["messages"][0]["content"])
        content = json.dumps(
            {
                "adhoc": {
                    "score": 80,
                    "issues": [],
                    "categoryScores": {"Necessary": 80, "Verifiable": 70},
                },
            },
        )
        return httpx.Response(200, json={"content": content})

    _patch_llm(monkeypatch, handler)

    response = client.post(
        "/score-item",
        json={
            "description": "The system shall be fast.",
            "category_checklist": ["Necessary", "Verifiable"],
        },
    )

    assert response.status_code == 200
    assert '["Necessary", "Verifiable"]' in captured_system_prompts[0]
    assert response.json()["quality_category_scores"] == {"Necessary": 80, "Verifiable": 70}


def test_score_item_returns_quality_confidence(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        content = json.dumps(
            {"adhoc": {"score": 72, "issues": ["ambiguous"], "categoryScores": {"clarity": 70}, "confidence": "low"}},
        )
        return httpx.Response(200, json={"content": content})

    _patch_llm(monkeypatch, handler)

    response = client.post("/score-item", json={"description": "The system shall be fast."})

    assert response.status_code == 200
    body = response.json()
    assert body["quality_confidence"] == "low"
    assert body["quality_score"] == 72


def test_score_item_confidence_is_null_when_the_model_said_nothing_usable(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        content = json.dumps({"adhoc": {"score": 72, "issues": [], "categoryScores": None}})
        return httpx.Response(200, json={"content": content})

    _patch_llm(monkeypatch, handler)

    body = client.post("/score-item", json={"description": "The system shall be fast."}).json()

    assert body["quality_confidence"] is None


def test_score_item_rejects_a_blank_description() -> None:
    response = client.post("/score-item", json={"description": "   "})
    assert response.status_code == 400


def test_score_item_without_user_id_never_attempts_kb_retrieval(monkeypatch) -> None:
    def _fail_retrieve_context(*args, **kwargs):  # pragma: no cover - should never run
        raise AssertionError("retrieve_context must not be called without a user_id")

    monkeypatch.setattr("app.main.retrieve_context", _fail_retrieve_context)

    def handler(request: httpx.Request) -> httpx.Response:
        content = json.dumps({"adhoc": {"score": 50, "issues": [], "categoryScores": None}})
        return httpx.Response(200, json={"content": content})

    _patch_llm(monkeypatch, handler)

    response = client.post("/score-item", json={"description": "The system shall be fast."})
    assert response.status_code == 200


def test_score_item_client_gets_the_survey_sampling_constants_and_a_resolved_num_ctx(monkeypatch) -> None:
    # The sibling topK/minP fix landed in score_requirements_for_document
    # (which this route reaches via score_single_requirement_text) but was
    # silently inert here, because this route's own client was constructed
    # with neither option -- SWEEP.md section 6's third un-configured
    # construction site. Unlike main.py's two module-level singletons, this
    # client has a real per-job model (body.model), so num_ctx is
    # resolvable too, exactly the way /level already resolves it.
    from app import main as main_module

    captured: dict = {}
    original_init = OrchestratorLlmClient.__init__

    def patched_init(self, base_url, bearer_token, model=None, num_ctx=None, top_k=None, min_p=None, seed=42, cache=None):
        # Record only the REAL client (the one carrying sampling options);
        # /level's own probe_client pattern constructs a throwaway first.
        captured.setdefault("calls", []).append({"model": model, "num_ctx": num_ctx, "top_k": top_k, "min_p": min_p})
        original_init(self, base_url, bearer_token, model=model)

        def handler(request: httpx.Request) -> httpx.Response:
            content = json.dumps({"adhoc": {"score": 70, "issues": [], "categoryScores": {"clarity": 70}}})
            return httpx.Response(200, json={"content": content})

        self._transport = httpx.MockTransport(handler)

    monkeypatch.setattr(OrchestratorLlmClient, "__init__", patched_init)
    monkeypatch.setattr("app.main.settings.llm_proxy_bearer", "test-bearer")

    response = client.post("/score-item", json={"description": "The system shall be fast.", "model": "some-unknown-model"})

    assert response.status_code == 200
    real_call = captured["calls"][-1]
    assert real_call["top_k"] == main_module._SURVEY_TOP_K
    assert real_call["min_p"] == main_module._SURVEY_MIN_P
    assert real_call["model"] == "some-unknown-model"
    assert isinstance(real_call["num_ctx"], int) and real_call["num_ctx"] > 0
