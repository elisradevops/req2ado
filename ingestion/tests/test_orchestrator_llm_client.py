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
