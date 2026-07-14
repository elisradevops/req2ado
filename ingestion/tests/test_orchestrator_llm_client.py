# ingestion/tests/test_orchestrator_llm_client.py
import json

import httpx
import pytest

from app.survey.orchestrator_llm_client import OrchestratorLlmClient


def _mock_transport(response_json: dict, expected_status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/chat"
        return httpx.Response(expected_status, json=response_json)

    return httpx.MockTransport(handler)


def test_generate_requirements_parses_valid_json_response() -> None:
    response_json = {
        "content": '[{"text": "The unit shall survive a 1m drop.", "tags": ["safety"]}]'
    }
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(response_json)  # test-only seam, see implementation

    result = client.generate_requirements("The unit must survive being dropped.")
    assert result == [{"text": "The unit shall survive a 1m drop.", "tags": ["safety"]}]


def test_generate_requirements_sends_temperature_zero() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(request.content)
        captured["temperature"] = body["temperature"]
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements("some block")
    assert captured["temperature"] == 0


def test_generate_requirements_raises_on_malformed_json_content() -> None:
    response_json = {"content": "not valid json"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    with pytest.raises(ValueError, match="malformed"):
        client.generate_requirements("some block")


def test_generate_requirements_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[]"}, expected_status=401)

    with pytest.raises(httpx.HTTPStatusError):
        client.generate_requirements("some block")


def test_infer_hierarchy_parses_the_response_into_a_hierarchy_list() -> None:
    hierarchy = [
        {"node_id": "0", "type": "Epic", "parent_id": None},
        {"node_id": "1", "type": "Requirement", "parent_id": "0"},
    ]
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["body"] = json.loads(request.content)
        captured["auth"] = request.headers["authorization"]
        return httpx.Response(200, json={"content": json.dumps(hierarchy)})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.infer_hierarchy("line 0\nline 1", None)

    assert result == hierarchy
    assert captured["auth"] == "Bearer test-bearer"
    assert captured["body"]["temperature"] == 0
    assert captured["body"]["messages"][1]["content"] == "line 0\nline 1"


def test_infer_hierarchy_raises_on_malformed_json() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "not valid json"})

    with pytest.raises(ValueError, match="malformed"):
        client.infer_hierarchy("line 0", None)


def test_infer_hierarchy_strips_a_markdown_json_fence() -> None:
    hierarchy = [{"node_id": "0", "type": "Epic", "parent_id": None}]
    response_json = {"content": "```json\n" + json.dumps(hierarchy) + "\n```"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.infer_hierarchy("line 0", None)
    assert result == hierarchy


def test_generate_requirements_for_document_sends_all_blocks_in_one_call() -> None:
    call_count = {"n": 0}
    response_body = {"n0": [{"text": "The unit shall power on.", "tags": ["functional"]}], "n1": []}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(200, json={"content": json.dumps(response_body)})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.generate_requirements_for_document({"n0": "block 0 text", "n1": "block 1 text"})

    assert result == response_body
    assert call_count["n"] == 1


def test_generate_requirements_for_document_strips_a_markdown_json_fence() -> None:
    response_body = {"n0": [{"text": "The unit shall power on.", "tags": ["functional"]}]}
    response_json = {"content": "```json\n" + json.dumps(response_body) + "\n```"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.generate_requirements_for_document({"n0": "block 0 text"})
    assert result == response_body


def test_infer_hierarchy_prepends_kb_context_when_present() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_hierarchy("some outline", None, kb_context="Reference chunk about displays.")
    assert captured["system_prompt"].startswith(
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        "Reference chunk about displays.\n\n"
    )
    assert "You infer a work-item hierarchy" in captured["system_prompt"]


def test_infer_hierarchy_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_hierarchy("some outline", None)
    assert captured["system_prompt"].startswith("You infer a work-item hierarchy")
    assert "Reference material from the knowledge base" not in captured["system_prompt"]


def test_generate_requirements_for_document_prepends_kb_context_when_present() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements_for_document({"0": "text"}, kb_context="Reference chunk about displays.")
    assert captured["system_prompt"].startswith(
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        "Reference chunk about displays.\n\n"
    )
    assert "You convert several informal requirement blocks" in captured["system_prompt"]


def test_generate_requirements_for_document_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements_for_document({"0": "text"})
    assert captured["system_prompt"].startswith("You convert several informal requirement blocks")
    assert "Reference material from the knowledge base" not in captured["system_prompt"]
