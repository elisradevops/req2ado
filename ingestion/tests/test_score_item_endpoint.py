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
