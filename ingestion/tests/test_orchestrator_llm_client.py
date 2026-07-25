# ingestion/tests/test_orchestrator_llm_client.py
import json

import httpx
import pytest

from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import RequirementQualityIssue, RequirementTag


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


def test_generate_requirements_strips_a_markdown_json_fence() -> None:
    # Regression: unlike infer_hierarchy/generate_requirements_for_document/
    # score_requirements_for_document, this method previously called
    # json.loads directly without _strip_json_fence -- a local model
    # fencing THIS response (the same model behavior every other method
    # already tolerates) would have raised a spurious "malformed JSON" error.
    requirements = [{"text": "The unit shall survive a 1m drop.", "tags": ["safety"]}]
    response_json = {"content": "```json\n" + json.dumps(requirements) + "\n```"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.generate_requirements("The unit must survive being dropped.")
    assert result == requirements


def test_generate_requirements_handles_an_empty_array_response() -> None:
    # A block that yields no formal requirement (e.g. pure boilerplate) is a
    # legitimate, non-error response -- must not raise or synthesize a
    # placeholder entry.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[]"})

    assert client.generate_requirements("Table of Contents") == []


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


def test_infer_hierarchy_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[]"}, expected_status=503)

    with pytest.raises(httpx.HTTPStatusError):
        client.infer_hierarchy("line 0", None)


def test_infer_hierarchy_handles_a_single_node_outline() -> None:
    # Smallest possible real input: one line, one root node, no children --
    # not an error/edge case for the client itself, just the minimum shape.
    hierarchy = [{"node_id": "0", "type": "Requirement", "parent_id": None}]
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps(hierarchy)})

    assert client.infer_hierarchy("line 0", None) == hierarchy


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


def test_generate_requirements_for_document_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "{}"}, expected_status=500)

    with pytest.raises(httpx.HTTPStatusError):
        client.generate_requirements_for_document({"n0": "block 0 text"})


def test_generate_requirements_for_document_handles_a_block_mapped_to_an_empty_list() -> None:
    # A heading-only or otherwise non-substantive block legitimately yields
    # no formal requirement at all -- an empty list value, not an error.
    response_body = {"n0": []}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps(response_body)})

    result = client.generate_requirements_for_document({"n0": "Table of Contents"})
    assert result == {"n0": []}


def test_generate_requirements_for_document_strips_a_markdown_json_fence() -> None:
    response_body = {"n0": [{"text": "The unit shall power on.", "tags": ["functional"]}]}
    response_json = {"content": "```json\n" + json.dumps(response_body) + "\n```"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.generate_requirements_for_document({"n0": "block 0 text"})
    assert result == response_body


def test_score_requirements_for_document_sends_all_descriptions_in_one_call() -> None:
    call_count = {"n": 0}
    response_body = {"n0": {"score": 85, "issues": []}, "n1": {"score": 40, "issues": ["ambiguous", "vague_term"]}}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(200, json={"content": json.dumps(response_body)})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds.", "n1": "The unit shall be user-friendly."})

    assert result == response_body
    assert call_count["n"] == 1


def test_score_requirements_for_document_includes_criteria_context_in_the_system_prompt_when_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"n0": {"score": 90, "issues": []}})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document(
        {"n0": "The unit shall power on within 2 seconds."},
        criteria_context="- vague_term: terms like 'fast' have no objective measure.",
    )

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "vague_term: terms like 'fast' have no objective measure." in system_prompt


def test_score_requirements_for_document_omits_criteria_context_section_when_not_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"n0": {"score": 90, "issues": []}})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "retrieved as most relevant" not in system_prompt


def test_score_requirements_for_document_strips_a_markdown_json_fence() -> None:
    response_body = {"n0": {"score": 90, "issues": []}}
    response_json = {"content": "```json\n" + json.dumps(response_body) + "\n```"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.score_requirements_for_document({"n0": "text"})
    assert result == response_body


def test_score_requirements_for_document_raises_on_malformed_json() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "not json"})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.score_requirements_for_document({"n0": "text"})


def test_score_requirements_for_document_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "{}"}, expected_status=429)

    with pytest.raises(httpx.HTTPStatusError):
        client.score_requirements_for_document({"n0": "text"})
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


def test_score_requirements_for_document_parses_valid_json_response() -> None:
    response_json = {
        "content": json.dumps({"0": {"score": 85, "issues": ["vague_term"]}})
    }
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.score_requirements_for_document({"0": "The system shall be fast."})
    assert result == {"0": {"score": 85, "issues": ["vague_term"]}}


def test_score_requirements_for_document_sends_temperature_zero() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["temperature"] = body["temperature"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})
    assert captured["temperature"] == 0


def test_score_requirements_for_document_raises_on_malformed_json_content() -> None:
    response_json = {"content": "not valid json"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    with pytest.raises(ValueError, match="malformed"):
        client.score_requirements_for_document({"0": "text"})


def test_score_requirements_for_document_prepends_kb_context_when_present() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"}, kb_context="Org rule: always specify units.")
    assert captured["system_prompt"].startswith(
        "Reference material from the knowledge base (may be incomplete or "
        "irrelevant — use only what's genuinely helpful):\n\n"
        "Org rule: always specify units.\n\n"
    )
    assert "EARS" in captured["system_prompt"] or "INCOSE" in captured["system_prompt"]


def test_score_requirements_for_document_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})
    assert "Reference material from the knowledge base" not in captured["system_prompt"]


def test_infer_trace_links_sends_nodes_and_catalog_returns_parsed_links() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system_prompt = body["messages"][0]["content"]
        assert "Elisra.CoveredBy-Forward" in system_prompt
        return httpx.Response(
            200,
            json={
                "content": json.dumps(
                    [{"source_node_id": "1", "target_ref": "0", "reference_name": "Elisra.CoveredBy-Forward"}]
                )
            },
        )

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.infer_trace_links(
        nodes=[
            {"node_id": "0", "type": "Requirement", "title": "Sys Req", "text": "The system shall X."},
            {"node_id": "1", "type": "Requirement", "title": "Cust Req", "text": "The customer requires X."},
        ],
        link_type_catalog=[
            {"reference_name": "Elisra.CoveredBy-Forward", "name": "Covered by", "semantic_hint": "system req covers customer req"},
        ],
    )

    assert result == [{"source_node_id": "1", "target_ref": "0", "reference_name": "Elisra.CoveredBy-Forward"}]


def test_infer_trace_links_raises_on_malformed_json() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "not json"})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.infer_trace_links(nodes=[], link_type_catalog=[])


def test_infer_trace_links_with_no_catalog_still_sends_a_valid_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["messages"][1]["content"]  # user content present
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.infer_trace_links(
        nodes=[{"node_id": "0", "type": "Requirement", "title": "T", "text": "X"}],
        link_type_catalog=[],
    )
    assert result == []


def test_infer_trace_links_prompt_mentions_external_customer_cited_targets() -> None:
    """The crossJob classification logic downstream treats any target_ref that
    isn't a known node_id as an external customer-id reference — but the LLM
    only emits one if the prompt tells it that's allowed. Guard the prompt
    wording so this path stays reachable in practice."""
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["system_prompt"] = body["messages"][0]["content"]
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_trace_links(nodes=[], link_type_catalog=[])

    system_prompt = captured["system_prompt"].lower()
    assert "external" in system_prompt or "customer" in system_prompt


def test_infer_hierarchy_includes_model_in_payload_when_set() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", model="qwen2.5:1.5b")
    client._transport = httpx.MockTransport(handler)

    client.infer_hierarchy("0: some outline", profile_hint=None)

    assert captured["body"]["model"] == "qwen2.5:1.5b"


def test_infer_hierarchy_omits_model_from_payload_when_unset() -> None:
    # Matches pre-model-selection behavior exactly: unset means "let the
    # orchestrator's own /llm/chat proxy fall back to its configured
    # LLM_CHAT_MODEL default" -- must not send a null/empty model key.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_hierarchy("0: some outline", profile_hint=None)

    assert "model" not in captured["body"]


def test_generate_requirements_never_sends_response_schema_to_avoid_gbnf_array_wedge() -> None:
    # A top-level array schema over branch-sized content hit Ollama's
    # GBNF grammar-cost cliff live (server-wide wedge, ollama/ollama#1910) --
    # this must stay omitted. Defended by tag filtering in llm_leveling.py.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements("some block")

    assert "responseSchema" not in captured["body"]
    # Unconstrained since no response_format -- capped so a reasoning
    # model's unbounded chain-of-thought can't run away (observed live:
    # 40+ minute single calls with no cap).
    assert captured["body"]["maxTokens"] == 20000


def test_infer_hierarchy_never_sends_response_schema_to_avoid_gbnf_array_wedge() -> None:
    # The exact call site that wedged Ollama's whole server for 10+ minutes
    # live on a ~200-item branch. Must stay omitted -- defended by the
    # WorkItemType ValueError->REQUIREMENT fallback in llm_leveling.py.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_hierarchy("0: some outline", profile_hint=None)

    assert "responseSchema" not in captured["body"]
    assert captured["body"]["maxTokens"] == 20000


def test_score_requirements_for_document_includes_an_issues_enum_schema_with_additional_properties() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "The unit shall survive a 1m drop."})

    schema = captured["body"]["responseSchema"]["schema"]
    # Dynamic node_id-keyed object -- must use additionalProperties, not a
    # fixed properties set, since keys are runtime node_ids.
    assert "additionalProperties" in schema
    issues_enum = schema["additionalProperties"]["properties"]["issues"]["items"]["enum"]
    assert set(issues_enum) == {i.value for i in RequirementQualityIssue}


def test_generate_requirements_for_document_includes_a_tags_enum_schema_with_additional_properties() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.generate_requirements_for_document({"0": "some block text"})

    schema = captured["body"]["responseSchema"]["schema"]
    assert "additionalProperties" in schema
    tags_enum = schema["additionalProperties"]["items"]["properties"]["tags"]["items"]["enum"]
    assert set(tags_enum) == {t.value for t in RequirementTag}


def test_infer_trace_links_never_sends_response_schema_even_with_a_nonempty_catalog() -> None:
    # Same GBNF array-wedge risk as infer_hierarchy (up to ~200 nodes across
    # a whole tree). Must stay omitted regardless of catalog size --
    # defended by the reference_name-not-in-catalog filter in llm_leveling.py.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    catalog = [
        {"reference_name": "Elisra.CoveredBy-Forward", "name": "Covered by"},
        {"reference_name": "System.LinkTypes.Related", "name": "Related"},
    ]
    client.infer_trace_links(nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}], link_type_catalog=catalog)

    assert "responseSchema" not in captured["body"]
    assert captured["body"]["maxTokens"] == 20000


def test_judge_kb_relevance_parses_the_verdict_map_and_includes_an_enum_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": '{"0": "relevant", "1": "not_relevant"}'})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.judge_kb_relevance(
        "The display shall support HDR.",
        [
            {"source_file": "relevant.docx", "text": "HDR display spec"},
            {"source_file": "irrelevant.docx", "text": "unrelated content"},
        ],
    )

    assert result == {"0": "relevant", "1": "not_relevant"}
    schema = captured["body"]["responseSchema"]["schema"]
    assert schema["additionalProperties"]["enum"] == ["relevant", "not_relevant"]
    user_content = json.loads(captured["body"]["messages"][1]["content"])
    assert user_content["snippets"]["0"]["source_file"] == "relevant.docx"


def test_infer_trace_links_omits_response_schema_when_catalog_is_empty() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.infer_trace_links(nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}], link_type_catalog=[])

    assert "responseSchema" not in captured["body"]


# --- analyze_section / analyze_section_agentic (§2b/§5b holistic redesign) ---


def test_analyze_section_parses_the_nodes_object_and_sends_response_schema() -> None:
    # Unlike the legacy array-shaped methods above, analyze_section DOES send
    # responseSchema -- section_analysis_schema() is object-wrapped
    # ({"nodes": [...]}) and deliberately maxItems-free, so it doesn't hit
    # the GBNF grammar-cost cliff the legacy methods avoid by omitting it.
    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The unit shall survive a 1m drop.", "tags": ["safety"]}]
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result, truncated = client.analyze_section("Some section text.")

    assert result == nodes
    assert truncated is False
    assert captured["body"]["temperature"] == 0
    assert captured["body"]["messages"][1]["content"] == "Some section text."
    schema = captured["body"]["responseSchema"]["schema"]
    assert schema["properties"]["nodes"]["type"] == "array"
    assert "maxItems" not in schema["properties"]["nodes"]


def test_analyze_section_caps_max_tokens_to_avoid_silent_truncation() -> None:
    # Regression, confirmed live: a real 679-block, 6-section document's
    # section 1 response truncated mid-array ('Expecting , delimiter') at
    # ~8.4KB -- analyze_section previously sent NO maxTokens at all, so
    # output was bounded by whatever small default Ollama/Open WebUI
    # applies, and a reasoning model (gemma4:e4b) burns hidden
    # chain-of-thought tokens before its actual JSON answer. Must send the
    # same _MAX_OUTPUT_TOKENS ceiling the legacy calls already trust.
    from app.survey.orchestrator_llm_client import _MAX_OUTPUT_TOKENS

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")

    assert captured["body"]["maxTokens"] == _MAX_OUTPUT_TOKENS


def test_analyze_section_agentic_caps_max_tokens_to_avoid_silent_truncation() -> None:
    from app.survey.orchestrator_llm_client import _MAX_OUTPUT_TOKENS

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic("Some section text.", lambda query: (None, []))

    assert captured["body"]["maxTokens"] == _MAX_OUTPUT_TOKENS


def test_analyze_section_includes_the_whole_document_hint_only_when_requested() -> None:
    from app.survey.orchestrator_llm_client import _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.", whole_document=True)
    assert _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT in captured["body"]["messages"][0]["content"]

    client.analyze_section("Some section text.", whole_document=False)
    assert _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT not in captured["body"]["messages"][0]["content"]


def test_analyze_section_agentic_includes_the_whole_document_hint_only_when_requested() -> None:
    from app.survey.orchestrator_llm_client import _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic("Some section text.", lambda query: (None, []), whole_document=True)
    assert _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT in captured["body"]["messages"][0]["content"]

    client.analyze_section_agentic("Some section text.", lambda query: (None, []), whole_document=False)
    assert _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT not in captured["body"]["messages"][0]["content"]


def test_analyze_section_whole_document_hint_states_the_topic_count() -> None:
    # Confirmed live: a qualitative-only hint does not change model
    # behavior -- a concrete floor tied to the document's own real heading
    # count is a much stronger signal.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.", whole_document=True, topic_count=79)
    system_content = captured["body"]["messages"][0]["content"]
    assert "79" in system_content
    assert "AT LEAST 79" in system_content
    assert "never invent, pad, or duplicate content to reach the count" in system_content


def test_analyze_section_agentic_whole_document_hint_states_the_topic_count() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic("Some section text.", lambda query: (None, []), whole_document=True, topic_count=79)
    system_content = captured["body"]["messages"][0]["content"]
    assert "79" in system_content
    assert "AT LEAST 79" in system_content


def test_whole_document_hint_falls_back_to_qualitative_when_no_topics() -> None:
    from app.survey.orchestrator_llm_client import _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT, _whole_document_hint

    # A "0 sections" floor would be nonsensical -- a headingless document
    # (topic_count 0 or None) must fall back to the qualitative-only hint,
    # with no digit injected.
    assert _whole_document_hint(0) == _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT
    assert _whole_document_hint(None) == _SECTION_ANALYSIS_WHOLE_DOCUMENT_HINT


def test_analyze_section_reports_truncated_when_finish_reason_is_length() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps({"nodes": []}), "finishReason": "length"})

    _, truncated = client.analyze_section("Some section text.")
    assert truncated is True


def test_analyze_section_reports_not_truncated_when_finish_reason_is_stop() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps({"nodes": []}), "finishReason": "stop"})

    _, truncated = client.analyze_section("Some section text.")
    assert truncated is False


def test_analyze_section_reports_not_truncated_when_finish_reason_is_absent() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps({"nodes": []})})

    _, truncated = client.analyze_section("Some section text.")
    assert truncated is False


def test_analyze_section_agentic_reports_truncated_when_final_answer_hits_finish_reason_length() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": json.dumps({"nodes": []}), "finishReason": "length"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    _, _, truncated = client.analyze_section_agentic("Some section text.", lambda query: (None, []))
    assert truncated is True


def test_analyze_section_agentic_reports_not_truncated_when_max_tool_rounds_exhausted() -> None:
    # Exhausting _MAX_TOOL_ROUNDS without ever reaching a final answer is a
    # DIFFERENT failure mode from a length-capped final answer -- the loop
    # gave up, it never got far enough to see a real finishReason.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"toolCalls": [{"id": "call-1", "function": {"name": "query_kb", "arguments": '{"query": "x"}'}}]}
        )

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, citations, truncated = client.analyze_section_agentic("Some section text.", lambda query: (None, []))
    assert nodes == []
    assert truncated is False


def test_analyze_section_tolerates_a_response_missing_only_the_final_closing_brace() -> None:
    # Regression, confirmed live and deterministic at temperature=0 against
    # a real 679-block AirPro document: Ollama's grammar-constrained
    # decoder (responseSchema) closed the "nodes" array correctly but never
    # emitted the outer object's own final '}' -- verified that appending
    # exactly one '}' recovers the full, otherwise well-formed response (all
    # 19 real nodes parsed correctly). Must not raise "malformed JSON" and
    # abort the whole job over this one confirmed failure shape.
    nodes = [{"temp_id": "n1", "type": "Epic", "parent_temp_id": None, "text": "The Backplane shall comply.", "tags": ["feature"]}]
    content_missing_final_brace = json.dumps({"nodes": nodes})[:-1]  # drop the trailing '}'
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": content_missing_final_brace})

    result, _ = client.analyze_section("Some section text.")
    assert result == nodes


def test_analyze_section_forwards_top_k_and_min_p_when_configured() -> None:
    # Gemma4 repetition-collapse mitigation (ollama/ollama#15502) -- these
    # sampler overrides are only sent when the caller (app.main) configured
    # them, same opt-in convention as num_ctx.
    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "x", "tags": []}]
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", top_k=50, min_p=0.05
    )
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")

    assert captured["body"]["topK"] == 50
    assert captured["body"]["minP"] == 0.05


def test_analyze_section_omits_top_k_and_min_p_when_not_configured() -> None:
    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "x", "tags": []}]
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")

    assert "topK" not in captured["body"]
    assert "minP" not in captured["body"]


def test_analyze_section_tolerates_a_node_missing_its_own_closing_brace() -> None:
    # Regression, confirmed live and deterministic at temperature=0 against
    # a real AirPro branch: Ollama's grammar-constrained decoder can omit a
    # single NODE object's own closing brace right before the "nodes"
    # array's closing bracket -- e.g. `..."tags": [...]\n  ]\n}` instead of
    # `..."tags": [...]\n  }\n  ]\n}`. Distinct failure shape from the
    # missing-FINAL-brace tolerance above (this is a missing brace in the
    # MIDDLE of the structure, not at the very end) -- verified that
    # inserting a single '}' right where the array closes recovers the full,
    # otherwise well-formed response.
    nodes = [
        {"temp_id": "n1", "type": "Epic", "parent_temp_id": None, "text": "The Backplane shall comply.", "tags": ["feature"]},
        {"temp_id": "n2", "type": "Requirement", "parent_temp_id": "n1", "text": "The BP shall support 7 slots.", "tags": []},
    ]
    well_formed = json.dumps({"nodes": nodes})
    # Remove exactly the LAST node object's own closing '}' (the one right
    # before the "nodes" array's closing ']') -- mirrors the real failure's
    # "Expecting ',' delimiter" at that ']'.
    last_brace_index = well_formed.rindex("}", 0, well_formed.rindex("]"))
    content_missing_node_brace = well_formed[:last_brace_index] + well_formed[last_brace_index + 1 :]

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": content_missing_node_brace})

    result, _ = client.analyze_section("Some section text.")
    assert result == nodes


def test_analyze_section_still_raises_when_malformed_for_a_different_reason() -> None:
    # The missing-final-brace tolerance above must not become a blanket
    # auto-repair engine -- a response that's malformed for any OTHER
    # reason (not just "missing exactly the outer closing brace") must
    # still raise, same as every other call site's malformed-JSON handling.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "not valid json at all"})

    with pytest.raises(ValueError, match="malformed"):
        client.analyze_section("Some section text.")


def test_analyze_section_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps({"nodes": []})}, expected_status=401)

    with pytest.raises(httpx.HTTPStatusError):
        client.analyze_section("Some section text.")


def test_analyze_section_strips_a_markdown_json_fence() -> None:
    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "x", "tags": []}]
    response_json = {"content": "```json\n" + json.dumps({"nodes": nodes}) + "\n```"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result, _ = client.analyze_section("Some section text.")
    assert result == nodes


def test_analyze_section_tolerates_a_bare_array_response() -> None:
    # Defensive unwrap (_nodes_from_parsed): the prompt asks for the
    # object-wrapped {"nodes": [...]} shape, but a schema-less degraded
    # response could come back as a bare array -- must not crash.
    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "x", "tags": []}]
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps(nodes)})

    result, _ = client.analyze_section("Some section text.")
    assert result == nodes


def test_analyze_section_includes_model_in_payload_when_set() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", model="qwen3:4b")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")

    assert captured["body"]["model"] == "qwen3:4b"


def test_analyze_section_omits_model_from_payload_when_unset() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")

    assert "model" not in captured["body"]


def test_analyze_section_prepends_kb_context_when_present() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.", kb_context="Reference material from doc-a.docx")

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "Reference material from doc-a.docx" in system_prompt


def test_analyze_section_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.", kb_context=None)

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "Reference material from the knowledge base" not in system_prompt


def test_analyze_section_agentic_calls_retrieve_fn_then_returns_final_nodes() -> None:
    # Full loop: first turn returns a query_kb tool call, retrieve_fn is
    # invoked with the model's own query, a {role:"tool"} result message is
    # appended, and the second turn's content is the final parsed answer.
    final_nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Grounded requirement.", "tags": []}]
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        body = json.loads(request.content)
        if call_count["n"] == 1:
            assert body["tools"][0]["function"]["name"] == "query_kb"
            return httpx.Response(
                200,
                json={
                    "toolCalls": [
                        {"id": "call-1", "function": {"name": "query_kb", "arguments": json.dumps({"query": "HDR spec"})}}
                    ]
                },
            )
        # Second turn: the tool-result message must have been appended.
        assert body["messages"][-1] == {"role": "tool", "tool_call_id": "call-1", "content": "context for: HDR spec"}
        return httpx.Response(200, json={"content": json.dumps({"nodes": final_nodes})})

    retrieved_queries: list[str] = []

    def retrieve_fn(query: str):
        retrieved_queries.append(query)
        return f"context for: {query}", [{"source_file": "spec.docx", "similarity": 0.8}]

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, citations, _ = client.analyze_section_agentic("Some section text.", retrieve_fn)

    assert nodes == final_nodes
    assert retrieved_queries == ["HDR spec"]
    assert citations == [{"source_file": "spec.docx", "similarity": 0.8}]
    assert call_count["n"] == 2


def test_analyze_section_agentic_sends_both_tools_and_response_schema() -> None:
    # Regression guard for a confirmed real bug: this call previously sent
    # tools WITHOUT responseSchema at all -- an implementation gap (every
    # other no-response_format call site in this module has an explicit
    # grammar-cost-cliff justification comment; this one had none), meaning
    # every real SURVEY call on a tool-capable model ran with ZERO
    # grammar-level JSON enforcement in production. Confirmed live
    # (malformed-JSON failures on a real AirPro branch) and verified
    # directly against Ollama 0.30.10 that `tools` + `response_format`
    # coexist without rejection, that a genuine tool-call round still
    # returns tool_calls correctly, and that a final-answer round stays
    # syntactically valid JSON once the schema is present.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic("Some section text.", lambda query: (None, []))

    assert "tools" in captured["body"]
    assert captured["body"]["responseSchema"]["schema"]["properties"]["nodes"]["type"] == "array"
    assert "maxItems" not in captured["body"]["responseSchema"]["schema"]["properties"]["nodes"]


def test_analyze_section_agentic_bounds_at_max_tool_rounds() -> None:
    # A misbehaving model that keeps calling query_kb forever must not loop
    # forever -- _MAX_TOOL_ROUNDS is a hard ceiling; degrades to no nodes
    # rather than hanging.
    from app.survey.orchestrator_llm_client import _MAX_TOOL_ROUNDS

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "toolCalls": [
                    {"id": "call-x", "function": {"name": "query_kb", "arguments": json.dumps({"query": "again"})}}
                ]
            },
        )

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    call_count = {"n": 0}

    def retrieve_fn(query: str):
        call_count["n"] += 1
        return f"context {call_count['n']}", [{"source_file": f"doc-{call_count['n']}.docx", "similarity": 0.5}]

    nodes, citations, _ = client.analyze_section_agentic("Some section text.", retrieve_fn)

    assert nodes == []
    assert call_count["n"] == _MAX_TOOL_ROUNDS
    assert len(citations) == _MAX_TOOL_ROUNDS  # one hit accumulated per round before giving up


def test_analyze_section_agentic_offers_full_document_tools_when_both_fns_supplied() -> None:
    # §15: list_kb_documents/read_kb_document are only offered when BOTH
    # closures are supplied by the caller -- omitting either (the pre-§15
    # default, exercised by every other analyze_section_agentic test in this
    # file) offers only query_kb, unchanged.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic(
        "Some section text.",
        lambda query: (None, []),
        list_documents_fn=lambda: ["spec.docx"],
        read_document_fn=lambda source_file: "full text",
    )

    tool_names = {t["function"]["name"] for t in captured["body"]["tools"]}
    assert tool_names == {"query_kb", "list_kb_documents", "read_kb_document"}


def test_analyze_section_agentic_list_kb_documents_tool_call_returns_document_names() -> None:
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200, json={"toolCalls": [{"id": "call-1", "function": {"name": "list_kb_documents", "arguments": "{}"}}]}
            )
        assert json.loads(request.content)["messages"][-1] == {
            "role": "tool", "tool_call_id": "call-1", "content": "spec.docx, other.docx",
        }
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, citations, _ = client.analyze_section_agentic(
        "Some section text.",
        lambda query: (None, []),
        list_documents_fn=lambda: ["spec.docx", "other.docx"],
        read_document_fn=lambda source_file: None,
    )

    assert nodes == []
    assert citations == []
    assert call_count["n"] == 2


def test_analyze_section_agentic_read_kb_document_tool_call_returns_full_text() -> None:
    call_count = {"n": 0}
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200,
                json={
                    "toolCalls": [
                        {"id": "call-1", "function": {"name": "read_kb_document", "arguments": json.dumps({"source_file": "spec.docx"})}}
                    ]
                },
            )
        assert json.loads(request.content)["messages"][-1] == {
            "role": "tool", "tool_call_id": "call-1", "content": "the full spec text",
        }
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    def read_document_fn(source_file: str) -> str | None:
        requested.append(source_file)
        return "the full spec text"

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic(
        "Some section text.", lambda query: (None, []), list_documents_fn=lambda: ["spec.docx"], read_document_fn=read_document_fn
    )

    assert requested == ["spec.docx"]


def test_analyze_section_agentic_read_kb_document_handles_a_missing_document_gracefully() -> None:
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200,
                json={
                    "toolCalls": [
                        {"id": "call-1", "function": {"name": "read_kb_document", "arguments": json.dumps({"source_file": "missing.docx"})}}
                    ]
                },
            )
        assert "not found" in json.loads(request.content)["messages"][-1]["content"]
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, _, _ = client.analyze_section_agentic(
        "Some section text.", lambda query: (None, []), list_documents_fn=lambda: [], read_document_fn=lambda source_file: None
    )
    assert nodes == []


def test_analyze_section_agentic_handles_no_query_argument_gracefully() -> None:
    # Tolerant of LLM non-compliance: a tool call missing/malformed
    # 'arguments' must not crash the loop -- degrades to "(no query
    # provided)" and never calls retrieve_fn for that round.
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200, json={"toolCalls": [{"id": "call-1", "function": {"name": "query_kb", "arguments": "not json"}}]}
            )
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    retrieve_calls = []
    nodes, citations, _ = client.analyze_section_agentic(
        "Some section text.", lambda query: retrieve_calls.append(query) or (None, [])
    )

    assert nodes == []
    assert retrieve_calls == []  # retrieve_fn never invoked -- no valid query to search with


def test_analyze_section_agentic_offers_read_other_section_only_when_fn_supplied() -> None:
    # whole-document redesign §3: read_other_section is orthogonal to the
    # §15 full-document KB tools -- offered independently based solely on
    # whether read_other_section_fn is supplied (the multi-branch fallback
    # path in llm_leveling.build_survey_tree).
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic(
        "Some section text.",
        lambda query: (None, []),
        read_other_section_fn=lambda section_id: "other section text",
    )

    tool_names = {t["function"]["name"] for t in captured["body"]["tools"]}
    assert tool_names == {"query_kb", "read_other_section"}


def test_analyze_section_agentic_does_not_offer_read_other_section_by_default() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic("Some section text.", lambda query: (None, []))

    tool_names = {t["function"]["name"] for t in captured["body"]["tools"]}
    assert tool_names == {"query_kb"}


def test_analyze_section_agentic_read_other_section_tool_call_returns_section_text() -> None:
    call_count = {"n": 0}
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200,
                json={
                    "toolCalls": [
                        {"id": "call-1", "function": {"name": "read_other_section", "arguments": json.dumps({"section_id": "3"})}}
                    ]
                },
            )
        assert json.loads(request.content)["messages"][-1] == {
            "role": "tool", "tool_call_id": "call-1", "content": "section 3's full text",
        }
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    def read_other_section_fn(section_id: str) -> str | None:
        requested.append(section_id)
        return "section 3's full text"

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic(
        "Some section text.", lambda query: (None, []), read_other_section_fn=read_other_section_fn
    )

    assert requested == ["3"]


def test_analyze_section_agentic_read_other_section_handles_a_missing_section_gracefully() -> None:
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200,
                json={
                    "toolCalls": [
                        {"id": "call-1", "function": {"name": "read_other_section", "arguments": json.dumps({"section_id": "99"})}}
                    ]
                },
            )
        assert "not found" in json.loads(request.content)["messages"][-1]["content"]
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, _, _ = client.analyze_section_agentic(
        "Some section text.", lambda query: (None, []), read_other_section_fn=lambda section_id: None
    )
    assert nodes == []
