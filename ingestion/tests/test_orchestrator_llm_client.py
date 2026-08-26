# ingestion/tests/test_orchestrator_llm_client.py
import json

import httpx
import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import app.survey.orchestrator_llm_client as orchestrator_llm_client_module
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import RequirementQualityIssue


def _mock_transport(response_json: dict, expected_status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/chat"
        return httpx.Response(expected_status, json=response_json)

    return httpx.MockTransport(handler)


def test_model_property_exposes_the_configured_per_job_override() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", model="qwen2.5:32b")
    assert client.model == "qwen2.5:32b"


def test_model_property_is_none_when_no_override_was_configured() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    assert client.model is None


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


def test_score_requirements_for_document_forwards_num_ctx_when_configured() -> None:
    # Regression guard: this call previously never forwarded num_ctx at
    # all -- Ollama silently truncates the prompt to its own small default
    # without it, regardless of how many requirements are being scored.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", num_ctx=32768)
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text"})

    assert captured["body"]["numCtx"] == 32768


def test_score_requirements_for_document_omits_num_ctx_when_not_configured() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text"})

    assert "numCtx" not in captured["body"]


def test_score_requirements_for_document_prompt_states_the_exact_expected_entry_count() -> None:
    # Regression guard, same confirmed-live pattern as _whole_document_hint/
    # _branch_topic_hint: a concrete, countable completeness instruction,
    # not just "never invent a node_id" -- addresses the real, already-
    # observed "no valid score for N node(s)" failure mode.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text", "n1": "text2", "n2": "text3"})

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "exactly 3 node_id(s)" in system_prompt
    assert "exactly 3 entries" in system_prompt


def test_score_requirements_for_document_raises_on_malformed_json_content() -> None:
    response_json = {"content": "not valid json"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    with pytest.raises(ValueError, match="malformed"):
        client.score_requirements_for_document({"0": "text"})


def test_score_requirements_for_document_repairs_a_bare_unescaped_quote_inside_a_string_value() -> None:
    # Confirmed real job failure (AirPro Backplane ICD, job d8cd0779): the
    # model embedded literal, unescaped double quotes inside a string value
    # for emphasis -- e.g. `the "Power-ON" Event` -- breaking the JSON
    # string mid-value. None of the three narrow, positional tolerances in
    # _parse_json_object (missing outer brace / missing node-object brace)
    # can repair this shape (it needs re-escaping, not a missing brace) --
    # only the general-purpose json_repair fallback reaches it. Previously
    # this raised "malformed JSON" and failed the whole job.
    raw_broken_json = (
        '{"n0": {"score": 40, "issues": [], '
        '"note": "the shall include the "Power-ON" Event function"}}'
    )
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": raw_broken_json})

    result = client.score_requirements_for_document({"n0": "text"})
    assert result["n0"]["score"] == 40


def test_score_requirements_for_document_prepends_kb_context_as_an_authoritative_rubric() -> None:
    # Scoring's kb_context framing is deliberately STRONGER than the
    # grounding call sites' "may be incomplete or irrelevant" wording -- an
    # org's own ingested requirements-writing standard should be treated as
    # the authoritative rubric for judging these requirements, not generic
    # background material the model may or may not use.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"}, kb_context="Org rule: always specify units.")
    assert captured["system_prompt"].startswith(
        "The following knowledge-base material was retrieved for this "
        "organization. If it defines its own requirements-writing "
    )
    assert "Org rule: always specify units." in captured["system_prompt"]
    assert "authoritative rubric for this organization" in captured["system_prompt"]
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


def test_extract_quality_checklist_parses_a_real_list() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps(["Necessary", "Unambiguous", "Verifiable"])})

    result = client.extract_quality_checklist("3.3 Customer requirement quality checklist\n...")
    assert result == ["Necessary", "Unambiguous", "Verifiable"]


def test_extract_quality_checklist_returns_empty_list_when_document_has_no_checklist() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[]"})

    result = client.extract_quality_checklist("Some unrelated document about airplanes.")
    assert result == []


def test_extract_quality_checklist_raises_on_a_non_list_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": '{"not": "a list"}'})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.extract_quality_checklist("text")


def test_extract_quality_checklist_raises_on_a_list_with_non_string_items() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[1, 2, 3]"})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.extract_quality_checklist("text")


def test_extract_quality_checklist_caps_input_length() -> None:
    # Confirmed real design constraint: a checklist definition is a small,
    # self-contained part of a document, not something needing whole-
    # document comprehension -- input is capped, not sent in full.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.extract_quality_checklist("x" * 50_000)

    user_content = captured["body"]["messages"][1]["content"]
    assert len(user_content) < 50_000


def test_extract_quality_checklist_falls_back_to_empty_when_too_many_items() -> None:
    # A nonsense/runaway extraction (way more than a real checklist would
    # ever have) is treated as "no checklist found" rather than stored and
    # replayed into every future scoring prompt.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps([f"Item {i}" for i in range(40)])})

    result = client.extract_quality_checklist("text")
    assert result == []


def test_extract_quality_checklist_falls_back_to_empty_when_only_one_item_survives() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps(["Solo item"])})

    result = client.extract_quality_checklist("text")
    assert result == []


def test_extract_quality_checklist_drops_an_oversized_item_but_keeps_the_rest() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    oversized = "x" * 500
    client._transport = _mock_transport(
        {"content": json.dumps(["Necessary", "Unambiguous", "Verifiable", oversized])}
    )

    result = client.extract_quality_checklist("text")
    assert result == ["Necessary", "Unambiguous", "Verifiable"]


def test_extract_quality_checklist_dedups_case_insensitively_preserving_first_seen_order_and_casing() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(
        {"content": json.dumps(["Necessary", "NECESSARY", "Unambiguous", "unambiguous", "Verifiable"])}
    )

    result = client.extract_quality_checklist("text")
    assert result == ["Necessary", "Unambiguous", "Verifiable"]


def test_extract_quality_checklist_well_formed_eleven_item_list_passes_through_unchanged() -> None:
    items = [
        "Necessary", "Unambiguous", "Verifiable", "Complete", "Consistent",
        "Feasible", "Traceable", "Correct", "Singular", "Testable", "Ranked",
    ]
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps(items)})

    result = client.extract_quality_checklist("text")
    assert result == items


def test_extract_quality_checklist_sends_temperature_zero_and_think_false() -> None:
    # Determinism requirement (user-reported): this runs ONCE per document
    # at ingest time and its result is stored/reused forever -- must itself
    # be as deterministic as this codebase's other structured-extraction
    # calls (temperature=0, think=False, same as analyze_section/scoring).
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.extract_quality_checklist("text")

    assert captured["body"]["temperature"] == 0
    assert captured["body"]["think"] is False


def test_extract_quality_checklist_definitions_parses_a_real_mapping() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(
        {"content": json.dumps({"Necessary": "The requirement states something not already satisfied."})}
    )

    result = client.extract_quality_checklist_definitions(
        "3.3 Customer requirement quality checklist\n...", ["Necessary", "Unambiguous"],
    )
    assert result == {"Necessary": "The requirement states something not already satisfied."}


def test_extract_quality_checklist_definitions_returns_empty_dict_with_no_category_names() -> None:
    # Deliberately never issues a call at all when the first extraction
    # pass (extract_quality_checklist) found no checklist -- nothing to ask
    # a definition for, see this method's own docstring.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(lambda request: (_ for _ in ()).throw(AssertionError("should not be called")))

    result = client.extract_quality_checklist_definitions("text", [])
    assert result == {}


def test_extract_quality_checklist_definitions_drops_a_key_not_in_category_names() -> None:
    # Confirmed real safeguard: a model that hallucinates or misspells a
    # category name in its response must never introduce a NEW key the
    # scores dict never had -- only the FIXED, already-decided names given
    # to this call are ever accepted.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(
        {"content": json.dumps({"Necessary": "Real def.", "Made Up Category": "Should be dropped."})}
    )

    result = client.extract_quality_checklist_definitions("text", ["Necessary", "Unambiguous"])
    assert result == {"Necessary": "Real def."}


def test_extract_quality_checklist_definitions_matches_case_insensitively_but_keys_by_canonical_name() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps({"NECESSARY": "Real def."})})

    result = client.extract_quality_checklist_definitions("text", ["Necessary"])
    assert result == {"Necessary": "Real def."}


def test_extract_quality_checklist_definitions_truncates_an_oversized_definition() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    oversized = "x" * 500
    client._transport = _mock_transport({"content": json.dumps({"Necessary": oversized})})

    result = client.extract_quality_checklist_definitions("text", ["Necessary"])
    assert result == {"Necessary": oversized[:280]}


def test_extract_quality_checklist_definitions_drops_empty_and_non_string_values() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(
        {"content": json.dumps({"Necessary": "   ", "Unambiguous": 5})}
    )

    result = client.extract_quality_checklist_definitions("text", ["Necessary", "Unambiguous"])
    assert result == {}


def test_extract_quality_checklist_definitions_raises_on_a_non_object_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[1, 2, 3]"})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.extract_quality_checklist_definitions("text", ["Necessary"])


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


def test_infer_trace_links_parses_json_prefaced_with_unfenced_conversational_prose() -> None:
    # Regression guard for a confirmed real job failure (qwen3.6:35b, a
    # real 554-node document -- the largest single-call payload in this
    # module): the model prefaced its reply with bare prose and NO markdown
    # fence at all ("Based on the provided nodes..."), so neither
    # _JSON_FENCE_PATTERN nor _JSON_FENCE_ANYWHERE_PATTERN matched (both
    # require a fence), and raw_decode() then failed at position 0 on the
    # word "Based" -- crashing trace-link inference for the whole job with
    # "malformed JSON in LLM response content: 'Based'".
    link = {"source_node_id": "1", "target_ref": "0", "reference_name": "Elisra.CoveredBy-Forward"}
    preamble = "Based on the provided nodes, here are the inferred links:\n\n"
    unfenced_prefaced_content = preamble + json.dumps([link])
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": unfenced_prefaced_content})

    result = client.infer_trace_links(nodes=[], link_type_catalog=[])

    assert result == [link]


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


def test_score_requirements_for_document_schema_allows_dynamic_category_scores() -> None:
    # Confirmed real gap fixed here: categoryScores was previously a FIXED
    # 5-property schema, which could never accept an org's own ingested KB
    # checklist category names (e.g. Necessary/Unambiguous/Verifiable/...).
    # additionalProperties (dynamic keys), not a fixed properties list --
    # same pattern this module already uses for the outer node_id-keyed
    # object and kb_relevance_schema.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "The unit shall survive a 1m drop."})

    entry_schema = captured["body"]["responseSchema"]["schema"]["additionalProperties"]
    assert "categoryScores" in entry_schema["required"]
    category_schema = entry_schema["properties"]["categoryScores"]
    assert "properties" not in category_schema
    assert category_schema["additionalProperties"] == {"type": "integer", "minimum": 0, "maximum": 100}


def test_score_requirements_for_document_prompt_explains_all_five_categories() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})

    for keyword in ("clarity", "testability", "atomicity", "style", "rationale"):
        assert keyword in captured["system_prompt"]


def test_score_requirements_for_document_prompt_covers_completeness_and_new_issue_tags() -> None:
    # Confirmed real gap: the prompt previously presupposed every candidate
    # was already a well-formed requirement statement, so a bare fragment
    # (e.g. "Size: 3U 1\"") scored as fully atomic with no way to flag it as
    # not-a-requirement at all.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})

    prompt = captured["system_prompt"]
    assert "completeness_as_requirement" in prompt
    for issue in (
        "not_a_requirement", "fragment", "placeholder", "open_item_tbd",
        "rationale_as_requirement", "conflicting_value",
    ):
        assert issue in prompt


def test_score_requirements_for_document_derives_dynamic_categories_when_kb_context_is_present() -> None:
    # Confirmed real gap fixed here (user-reported): with a real ingested KB
    # standard, the prompt must ask the model to derive categoryScores KEYS
    # from that material's own checklist instead of always locking to the
    # generic clarity/testability/atomicity/style/rationale 5-tuple.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"}, kb_context="Org standard: Necessary, Unambiguous, Verifiable.")

    prompt = captured["system_prompt"]
    assert "you derive from the organization" in prompt
    assert "Necessary" in prompt  # example checklist names surfaced to the model
    # Determinism instruction: same key set across every node in the batch.
    assert "EXACT SAME set of keys" in prompt
    # Still documents the fallback for when the material has no clear checklist.
    assert "clarity, testability, atomicity, style, rationale" in prompt


def test_score_requirements_for_document_uses_fixed_categories_without_kb_context() -> None:
    # Backward-compat: no kb_context -> byte-identical fixed 5-category
    # instruction, no "derive"/dynamic-key language at all.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})

    prompt = captured["system_prompt"]
    assert "FIVE independent integer" in prompt
    assert "you derive from the organization" not in prompt


def test_score_requirements_for_document_with_fixed_checklist_and_kb_context_drops_derive_language() -> None:
    # Real contradiction fixed here: when category_checklist (fixed,
    # pre-extracted) AND kb_context are BOTH present -- the common case --
    # the prompt used to contain both "derive your categoryScores key names
    # from this material" (from _with_kb_context_as_scoring_rubric) and,
    # separately, "use EXACTLY these categories... do not add, omit,
    # rename, or reorder any" (from the fixed-checklist category_instruction
    # branch). The fixed instruction must be the only one present -- no
    # "derive" language survives alongside it.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document(
        {"0": "text"},
        kb_context="Org standard: Necessary, Unambiguous, Verifiable.",
        category_checklist=["Necessary", "Unambiguous", "Verifiable"],
    )

    prompt = captured["system_prompt"]
    assert "you derive from the organization" not in prompt
    assert "derive your categoryScores key names" not in prompt
    assert "do not add, omit, rename, or reorder any" in prompt
    assert "Necessary" in prompt


def test_score_epics_and_features_for_document_sends_type_aware_prompt_and_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_epics_and_features_for_document(
        {
            "n0": {"type": "Epic", "text": "Automated Customer Requirements Processing."},
            "n1": {"type": "Feature", "text": "Parse and normalize uploaded requirement documents."},
        }
    )

    prompt = captured["body"]["messages"][0]["content"]
    assert "scopeCoherence" in prompt
    assert "outcomeClarity" in prompt
    assert "capabilityClarity" in prompt
    assert "decomposability" in prompt
    assert "exactly 2 node_id(s)" in prompt
    assert "exactly 2 entries" in prompt
    # No 'issues' vocabulary at all -- RequirementQualityIssue's closed
    # vocabulary (ambiguous, not_testable, ...) describes atomic statements,
    # not what an Epic/Feature grouping is.
    assert "not_testable" not in prompt
    schema = captured["body"]["responseSchema"]["schema"]["additionalProperties"]
    assert set(schema["required"]) == {"score", "categoryScores"}
    assert captured["body"]["temperature"] == 0
    assert captured["body"]["think"] is False


def test_score_epics_and_features_for_document_parses_valid_response() -> None:
    response_json = {
        "content": json.dumps(
            {
                "n0": {"score": 85, "categoryScores": {"scopeCoherence": 90, "outcomeClarity": 80}},
            }
        )
    }
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.score_epics_and_features_for_document({"n0": {"type": "Epic", "text": "text"}})
    assert result["n0"]["score"] == 85
    assert result["n0"]["categoryScores"] == {"scopeCoherence": 90, "outcomeClarity": 80}


def test_title_and_tags_for_rows_sends_the_closed_tag_vocabulary_and_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.title_and_tags_for_rows({"det0_h1": "Size: 3U 1\"", "det0_h2": "Over-current"})

    prompt = captured["body"]["messages"][0]["content"]
    assert "exactly 2 row(s)" in prompt
    assert "exactly 2 entries" in prompt
    assert "functional" in prompt and "safety" in prompt  # closed RequirementTag vocabulary present
    schema = captured["body"]["responseSchema"]["schema"]["additionalProperties"]
    assert set(schema["required"]) == {"title", "tags"}
    assert captured["body"]["temperature"] == 0
    assert captured["body"]["think"] is False


def test_title_and_tags_for_rows_parses_valid_response() -> None:
    response_json = {
        "content": json.dumps(
            {"det0_h1": {"title": "COTS power supply form factor", "tags": ["interface"]}}
        )
    }
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.title_and_tags_for_rows({"det0_h1": "Size: 3U 1\""})
    assert result["det0_h1"]["title"] == "COTS power supply form factor"
    assert result["det0_h1"]["tags"] == ["interface"]


def test_synthesize_leaf_requirements_sends_context_and_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.synthesize_leaf_requirements(
        {"det0_h1": {"text": "Size: 3U 1\"", "context": "Power Supply"}}
    )

    body = captured["body"]
    assert json.loads(body["messages"][1]["content"]) == {
        "det0_h1": {"text": "Size: 3U 1\"", "context": "Power Supply"}
    }
    prompt = body["messages"][0]["content"]
    assert "exactly 1 row(s)" in prompt
    assert "exactly 1 entries" in prompt
    schema = body["responseSchema"]["schema"]["additionalProperties"]
    assert set(schema["required"]) == {"title", "text", "tags"}
    assert body["temperature"] == 0
    assert body["think"] is False


def test_synthesize_leaf_requirements_parses_valid_response() -> None:
    response_json = {
        "content": json.dumps(
            {
                "det0_h1": {
                    "title": "COTS power supply form factor",
                    "text": "The COTS power supply shall have a 3U, 1-inch form factor.",
                    "tags": ["interface"],
                }
            }
        )
    }
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.synthesize_leaf_requirements(
        {"det0_h1": {"text": "Size: 3U 1\"", "context": "Power Supply"}}
    )
    assert result["det0_h1"]["text"] == "The COTS power supply shall have a 3U, 1-inch form factor."
    assert result["det0_h1"]["title"] == "COTS power supply form factor"
    assert result["det0_h1"]["tags"] == ["interface"]


def test_judge_duplicate_cluster_sends_the_verdict_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.judge_duplicate_cluster({"n0": "at least 85%", "n1": "at-least 93%"})

    body = captured["body"]
    prompt = body["messages"][0]["content"]
    assert "contradictory" in prompt
    assert "redundant" in prompt
    schema = body["responseSchema"]["schema"]
    assert set(schema["properties"]["verdict"]["enum"]) == {"redundant", "contradictory", "distinct"}
    assert schema["required"] == ["verdict", "conflicting_values"]
    assert body["temperature"] == 0
    assert body["think"] is False


def test_judge_duplicate_cluster_parses_a_contradictory_verdict() -> None:
    response_json = {
        "content": json.dumps({"verdict": "contradictory", "conflicting_values": ["85%", "93%"]})
    }
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.judge_duplicate_cluster({"n0": "at least 85%", "n1": "at-least 93%"})
    assert result["verdict"] == "contradictory"
    assert result["conflicting_values"] == ["85%", "93%"]


def test_group_root_topics_sends_only_titles_and_the_groups_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.group_root_topics({"n0": "PS_SYSRESET", "n1": "PS_SYNC"})

    body = captured["body"]
    assert json.loads(body["messages"][1]["content"]) == {"n0": "PS_SYSRESET", "n1": "PS_SYNC"}
    schema = body["responseSchema"]["schema"]
    assert schema["required"] == ["groups"]
    group_item_schema = schema["properties"]["groups"]["items"]
    assert set(group_item_schema["required"]) == {"title", "member_ids"}
    assert body["temperature"] == 0
    assert body["think"] is False


def test_group_root_topics_parses_a_valid_response() -> None:
    response_json = {
        "content": json.dumps(
            {"groups": [{"title": "VPX Utility & Management Signals", "member_ids": ["n0", "n1"]}]}
        )
    }
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.group_root_topics({"n0": "PS_SYSRESET", "n1": "PS_SYNC"})
    assert result["groups"][0]["title"] == "VPX Utility & Management Signals"
    assert result["groups"][0]["member_ids"] == ["n0", "n1"]


def test_assign_leftover_roots_sends_leftovers_and_groups_and_the_assignments_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.assign_leftover_roots(
        {"n2": "SBC Serial Communication Routing"},
        {"regroup_synth_group_0": "Bus Interfaces (I2C, SMBus, UART, USB)"},
    )

    body = captured["body"]
    assert json.loads(body["messages"][1]["content"]) == {
        "leftovers": {"n2": "SBC Serial Communication Routing"},
        "groups": {"regroup_synth_group_0": "Bus Interfaces (I2C, SMBus, UART, USB)"},
    }
    schema = body["responseSchema"]["schema"]
    assert schema["required"] == ["assignments"]
    assert body["temperature"] == 0
    assert body["think"] is False


def test_assign_leftover_roots_parses_a_valid_response() -> None:
    response_json = {"content": json.dumps({"assignments": {"n2": "regroup_synth_group_0"}})}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.assign_leftover_roots({"n2": "SBC Serial Communication Routing"}, {"regroup_synth_group_0": "Bus Interfaces"})
    assert result["assignments"] == {"n2": "regroup_synth_group_0"}


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


def test_infer_trace_links_disables_reasoning_and_forwards_num_ctx_when_configured() -> None:
    # Regression guard: relationship inference over already-generated nodes
    # is structured extraction, not open-ended reasoning -- same
    # confirmed-live finding (3-10x wall-clock cost, no accuracy benefit)
    # as analyze_section/analyze_section_agentic/score_requirements_for_document.
    # num_ctx was also missing entirely -- this call serializes EVERY node
    # in the whole tree, the largest single payload in this module, making
    # it the most exposed to Ollama's silent default-context truncation.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", num_ctx=32768)
    client._transport = httpx.MockTransport(handler)

    client.infer_trace_links(nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}], link_type_catalog=[])

    assert captured["body"]["think"] is False
    assert captured["body"]["numCtx"] == 32768


def test_judge_kb_relevance_disables_reasoning_caps_output_and_forwards_num_ctx() -> None:
    # Regression guard: this was the ONE call in this module with no
    # output cap at all -- the exact unbounded-hidden-reasoning exposure
    # _MAX_OUTPUT_TOKENS's own doc comment documents (a reasoning model
    # observed generating 40+ minute single calls with no cap in place).
    # Also missing num_ctx and think:False, same fix as its siblings.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", num_ctx=32768)
    client._transport = httpx.MockTransport(handler)

    client.judge_kb_relevance("some section content", [{"source_file": "a.pdf", "text": "snippet"}])

    assert captured["body"]["think"] is False
    assert captured["body"]["maxTokens"] == 20000
    assert captured["body"]["numCtx"] == 32768


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


def test_infer_trace_links_orders_catalog_native_types_first() -> None:
    # Task 5: native ADO link types (reference names starting with System. or
    # Microsoft.VSTS.) should be ordered first in the catalog, followed by
    # custom org-defined types. This ensures the model prefers native types
    # when they fit the relationship.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    # Input catalog: custom type first, native type second
    catalog = [
        {"reference_name": "Elisra.CoveredBy-Forward", "name": "Covered by"},
        {"reference_name": "System.LinkTypes.Affects-Forward", "name": "Affects"},
    ]
    client.infer_trace_links(nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}], link_type_catalog=catalog)

    system_prompt = captured["body"]["messages"][0]["content"]
    # Native type should appear before custom type in the system prompt
    native_index = system_prompt.index("System.LinkTypes.Affects-Forward")
    custom_index = system_prompt.index("Elisra.CoveredBy-Forward")
    assert native_index < custom_index, "Native types should be ordered before custom types in the catalog"


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


class _CountingFakeRedis:
    """Hand-written fake, same convention as test_narration_publisher.py's
    _FakeRedis -- backs LlmResponseCache directly (no fakeredis dependency),
    tracking call counts so these tests can assert the LLM HTTP call itself
    was skipped on a cache hit, not just that the returned value matched."""

    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}

    def get(self, key: str):
        return self._store.get(key)

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        self._store[key] = value.encode()


def test_analyze_section_cache_miss_then_hit_skips_the_second_llm_call() -> None:
    from app.survey.llm_cache import LlmResponseCache

    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Cached node.", "tags": []}]
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    client._transport = httpx.MockTransport(handler)

    first_result, first_truncated = client.analyze_section("Some section text.")
    second_result, second_truncated = client.analyze_section("Some section text.")

    assert call_count == 1  # second call hit the cache, never reached the transport
    assert first_result == nodes
    assert second_result == nodes
    assert first_truncated is False
    assert second_truncated is False


def test_analyze_section_cache_never_stores_a_truncated_result() -> None:
    from app.survey.llm_cache import LlmResponseCache

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps({"nodes": []}), "finishReason": "length"})

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")
    client.analyze_section("Some section text.")

    # A truncated result must never be cached -- both calls should reach the
    # real transport rather than the second one silently reusing a
    # known-incomplete answer.
    assert call_count == 2


def test_analyze_section_cache_key_differs_by_section_text_no_false_positive_hit() -> None:
    from app.survey.llm_cache import LlmResponseCache

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        text = body["messages"][1]["content"]
        return httpx.Response(200, json={"content": json.dumps({"nodes": [{"temp_id": text}]})})

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    client._transport = httpx.MockTransport(handler)

    result_a, _ = client.analyze_section("Section A text.")
    result_b, _ = client.analyze_section("Section B text.")

    assert result_a == [{"temp_id": "Section A text."}]
    assert result_b == [{"temp_id": "Section B text."}]  # not a stale cache hit from section A


def test_score_requirements_for_document_cache_miss_then_hit_skips_the_second_llm_call() -> None:
    from app.survey.llm_cache import LlmResponseCache

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps({"n0": {"score": 80}})})

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    client._transport = httpx.MockTransport(handler)

    first = client.score_requirements_for_document({"n0": "The unit shall survive a drop."})
    second = client.score_requirements_for_document({"n0": "The unit shall survive a drop."})

    assert call_count == 1
    assert first == {"n0": {"score": 80}}
    assert second == {"n0": {"score": 80}}


def test_score_epics_and_features_for_document_cache_miss_then_hit_skips_the_second_llm_call() -> None:
    from app.survey.llm_cache import LlmResponseCache

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps({"n0": {"score": 90, "categoryScores": {}}})})

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    client._transport = httpx.MockTransport(handler)

    first = client.score_epics_and_features_for_document({"n0": {"type": "Epic", "text": "Perimeter security"}})
    second = client.score_epics_and_features_for_document({"n0": {"type": "Epic", "text": "Perimeter security"}})

    assert call_count == 1
    assert first == {"n0": {"score": 90, "categoryScores": {}}}
    assert second == {"n0": {"score": 90, "categoryScores": {}}}


def test_analyze_section_without_a_cache_configured_always_calls_the_llm() -> None:
    # Default (cache=None) must behave exactly as before caching existed --
    # every existing OrchestratorLlmClient construction site that never
    # passes cache= is unaffected.
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")
    client.analyze_section("Some section text.")

    assert call_count == 2


def test_analyze_section_records_a_real_otel_span_with_gen_ai_attributes(monkeypatch) -> None:
    # Real verification (S6), not a mock: a genuinely separate SDK
    # TracerProvider + InMemorySpanExporter, independent of the process-wide
    # provider conftest.py disables for every other test (OTEL_SDK_DISABLED
    # only gates the global API's trace.get_tracer(), not a directly
    # instantiated SDK TracerProvider like this one) -- proves the span is
    # actually recorded with real attributes, not just that the call doesn't
    # crash.
    # TracerProvider itself (not just trace.get_tracer()) checks
    # OTEL_SDK_DISABLED at construction time -- conftest.py sets it for
    # every other test, so it must be overridden here before instantiating
    # a real provider, or this test's own provider would ALSO no-op.
    monkeypatch.setenv("OTEL_SDK_DISABLED", "false")
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(orchestrator_llm_client_module, "_tracer", provider.get_tracer("test"))

    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "The unit shall survive a 1m drop.", "tags": []}]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", model="qwen3.6:35b")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "analyze_section"
    assert spans[0].attributes["gen_ai.request.model"] == "qwen3.6:35b"
    assert spans[0].attributes["gen_ai.operation.name"] == "chat"
    assert spans[0].attributes["gen_ai.response.node_count"] == 1


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


def test_analyze_section_disables_reasoning_via_the_think_field() -> None:
    # Confirmed live (qwen3.6:35b, gemma4:31b): a reasoning-capable model's
    # hidden chain-of-thought added 3-10x wall-clock time on this holistic
    # JSON-extraction call with no observed accuracy benefit -- must be
    # disabled via the orchestrator's `think` passthrough (see
    # LlmChatOptions.think in the orchestrator's llm-client.interface.ts).
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")

    assert captured["body"]["think"] is False


def test_score_requirements_for_document_disables_reasoning_via_the_think_field() -> None:
    # Regression guard for a confirmed real user complaint (scoring 83
    # requirements in one call ran extremely slowly): unlike
    # analyze_section/analyze_section_agentic (both already proven to be
    # 3-10x faster with reasoning disabled, same finding, see those tests'
    # own doc comments), this call never set `think: False` at all --
    # meaning a reasoning-capable model burned hidden chain-of-thought
    # tokens before ANY output, for every one of the batch's items, on a
    # call that is pure structured judgment, not creative reasoning.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text"})

    assert captured["body"]["think"] is False
    assert captured["body"]["maxTokens"] == 20000


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


def test_analyze_section_agentic_disables_reasoning_via_the_think_field() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic("Some section text.", lambda query: (None, []))

    assert captured["body"]["think"] is False


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


def test_analyze_section_includes_table_group_hints_when_supplied() -> None:
    # Confirmed live (a real 3-run re-test): a QUALITATIVE-only instruction
    # to "use the source's own group label" measured ZERO effect on model
    # behavior. This concrete, named-groups hint is the fix -- states the
    # real count, the actual labels, AND each one's own suggested type
    # (Epic/Feature/Requirement -- a second confirmed gap: the original
    # version never mentioned Epic as an option at all).
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section(
        "Some section text.", topic_count=3,
        table_group_hints=[("Display", "Feature"), ("Television Receiver", "Epic")],
    )
    system_content = captured["body"]["messages"][0]["content"]
    assert "'Display' (Feature)" in system_content
    assert "'Television Receiver' (Epic)" in system_content
    assert "2 structural group(s)" in system_content


def test_analyze_section_agentic_includes_table_group_hints_when_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic(
        "Some section text.", lambda query: (None, []), topic_count=3,
        table_group_hints=[("Display", "Feature")],
    )
    system_content = captured["body"]["messages"][0]["content"]
    assert "'Display' (Feature)" in system_content


def test_analyze_section_omits_table_group_hint_when_no_labels_supplied() -> None:
    # Byte-identical-to-before-this-capability behavior when there are no
    # qualifying table groups (the overwhelmingly common case for
    # heading-leveled documents like AirPro-style ICDs).
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.", topic_count=3)
    system_content = captured["body"]["messages"][0]["content"]
    assert "structural group(s)" not in system_content


def test_table_group_hint_logs_a_warning_when_feature_groups_are_dropped(caplog) -> None:
    from app.survey.orchestrator_llm_client import _table_group_hint

    hints = [(f"Group {i}", "Feature") for i in range(50)]
    with caplog.at_level("WARNING"):
        _table_group_hint(hints)
    assert any("dropped" in record.message for record in caplog.records)


def test_analyze_section_default_root_wording_when_no_expected_root_count() -> None:
    # Byte-identical to today's single-root wording when expected_root_count
    # is omitted/None/<2 -- the overwhelmingly common case.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.")
    system_content = captured["body"]["messages"][0]["content"]
    assert "At most ONE node in your entire response should have parent_temp_id null" in system_content


def test_analyze_section_states_the_expected_root_count_when_multi_root() -> None:
    # Confirmed live: 2 independent top-level Epics ("Television Receiver",
    # "Remote Control") were both individually named in the table-group
    # hint, yet the model still invented a single wrapping root -- because
    # the hardcoded "at most ONE" rule left no room for a real multi-root
    # document. This concrete count is the fix.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section("Some section text.", expected_root_count=2)
    system_content = captured["body"]["messages"][0]["content"]
    assert "At most ONE node" not in system_content
    assert "up to 2 nodes may have parent_temp_id null" in system_content
    assert "invented wrapping ancestor" in system_content


def test_analyze_section_agentic_states_the_expected_root_count_when_multi_root() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_agentic(
        "Some section text.", lambda query: (None, []), expected_root_count=3
    )
    system_content = captured["body"]["messages"][0]["content"]
    assert "up to 3 nodes may have parent_temp_id null" in system_content


def test_table_group_hint_caps_the_number_of_feature_labels_spelled_out_verbatim() -> None:
    from app.survey.orchestrator_llm_client import _table_group_hint

    hints = [(f"Group {i}", "Feature") for i in range(50)]
    hint = _table_group_hint(hints)
    assert "50 structural group(s)" in hint  # true count always stated in full
    assert "Group 0" in hint
    assert "Group 39" in hint
    assert "Group 49" not in hint  # beyond the Feature-only display cap
    assert "10 more" in hint


def test_table_group_hint_never_caps_epic_or_requirement_groups() -> None:
    """Confirmed live: a flat positional cap silently dropped 2 REAL groups
    (a Feature and a Requirement) purely because of table order, not
    because they were less significant -- EPIC/REQUIREMENT groups must
    never be subject to any cap, only the common FEATURE case."""
    from app.survey.orchestrator_llm_client import _table_group_hint

    hints = [(f"Feature Group {i}", "Feature") for i in range(50)]
    hints.append(("Late Epic", "Epic"))
    hints.append(("Late Requirement", "Requirement"))
    hint = _table_group_hint(hints)
    assert "Late Epic" in hint
    assert "Late Requirement" in hint


def test_table_group_hint_is_empty_for_no_labels() -> None:
    from app.survey.orchestrator_llm_client import _table_group_hint

    assert _table_group_hint(None) == ""
    assert _table_group_hint([]) == ""


def test_requirement_row_hint_names_every_identified_row_and_its_true_count() -> None:
    from app.survey.orchestrator_llm_client import _requirement_row_hint

    hint = _requirement_row_hint([("P-SENSOR-001#", "Time sync source"), ("P-SENSOR-002#", "Sync accuracy")])
    assert "2 individual row(s)" in hint
    assert "P-SENSOR-001#" in hint
    assert "Time sync source" in hint
    assert "P-SENSOR-002#" in hint
    assert "customer_id" in hint


def test_requirement_row_hint_caps_the_rows_named_but_states_the_true_count() -> None:
    from app.survey.orchestrator_llm_client import _MAX_REQUIREMENT_ROWS_NAMED, _requirement_row_hint

    hints = [(f"REQ-{i:03d}", f"Row {i}") for i in range(_MAX_REQUIREMENT_ROWS_NAMED + 10)]
    hint = _requirement_row_hint(hints)
    assert f"{len(hints)} individual row(s)" in hint  # true count always stated in full
    assert "REQ-000" in hint
    assert f"REQ-{_MAX_REQUIREMENT_ROWS_NAMED - 1:03d}" in hint
    assert f"REQ-{_MAX_REQUIREMENT_ROWS_NAMED:03d}" not in hint  # beyond the display cap
    assert "10 more" in hint


def test_requirement_row_hint_omits_the_label_parenthetical_when_blank() -> None:
    from app.survey.orchestrator_llm_client import _requirement_row_hint

    hint = _requirement_row_hint([("P-SENSOR-009#", "")])
    assert "'P-SENSOR-009#'" in hint
    assert "'P-SENSOR-009#' ()" not in hint


def test_heading_outline_hint_names_every_heading_and_its_true_count() -> None:
    from app.survey.orchestrator_llm_client import _heading_outline_hint

    hint = _heading_outline_hint([("Functional and Performance", "Epic"), ("Synchronization", "Feature")])
    assert "for 2 of its real headings" in hint
    assert "'Functional and Performance' (Epic)" in hint
    assert "'Synchronization' (Feature)" in hint
    assert "Heading 1" not in hint  # no absolute heading-level phrasing anywhere
    assert "Heading 2" not in hint


def test_heading_outline_hint_drops_requirement_typed_pairs_before_naming_or_counting() -> None:
    # Phase 1 (see heading_outline.py's own docstring): the detector
    # honestly reports Requirement-typed headings (a leaf whose own text
    # IS the requirement), but this hint never names them and the stated
    # count reflects only what's actually named -- not the raw input length.
    from app.survey.orchestrator_llm_client import _heading_outline_hint

    hint = _heading_outline_hint([("Domain", "Epic"), ("Sync", "Feature"), ("Leaf One", "Requirement"), ("Leaf Two", "Requirement")])
    assert "for 2 of its real headings" in hint
    assert "Leaf One" not in hint
    assert "Leaf Two" not in hint


def test_heading_outline_hint_caps_features_named_but_never_epics() -> None:
    from app.survey.orchestrator_llm_client import _MAX_HEADING_FEATURES_NAMED, _heading_outline_hint

    epics = [(f"Epic {i}", "Epic") for i in range(5)]
    features = [(f"Feature {i}", "Feature") for i in range(_MAX_HEADING_FEATURES_NAMED + 10)]
    hint = _heading_outline_hint(epics + features)
    for i in range(5):
        assert f"'Epic {i}' (Epic)" in hint  # every Epic named, uncapped
    assert f"'Feature {_MAX_HEADING_FEATURES_NAMED - 1}' (Feature)" in hint
    assert f"'Feature {_MAX_HEADING_FEATURES_NAMED}' (Feature)" not in hint
    assert "10 more" in hint
    assert f"for {5 + _MAX_HEADING_FEATURES_NAMED + 10} of its real headings" in hint  # true named count always stated


def test_heading_outline_hint_adds_a_single_tier_clause_only_when_no_epic_is_named() -> None:
    from app.survey.orchestrator_llm_client import _heading_outline_hint

    flat_hint = _heading_outline_hint([("Synchronization", "Feature"), ("Connectors", "Feature")])
    assert "ONE tier only" in flat_hint
    assert "Do NOT invent an Epic" in flat_hint

    tiered_hint = _heading_outline_hint([("Domain", "Epic"), ("Sync", "Feature")])
    assert "ONE tier only" not in tiered_hint


def test_heading_outline_hint_is_empty_for_no_headings_or_only_requirement_typed_ones() -> None:
    from app.survey.orchestrator_llm_client import _heading_outline_hint

    assert _heading_outline_hint(None) == ""
    assert _heading_outline_hint([]) == ""
    assert _heading_outline_hint([("Leaf", "Requirement")]) == ""


def test_analyze_section_skeleton_prompt_names_every_identified_heading() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton(
        "Some section text.", heading_type_hints=[("Target Handling", "Epic"), ("Target tracking", "Feature")],
    )

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "'Target Handling' (Epic)" in system_prompt
    assert "'Target tracking' (Feature)" in system_prompt


def test_analyze_section_skeleton_omits_the_heading_outline_hint_when_none_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton("Some section text.")

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "of its real headings" not in system_prompt


def test_analyze_section_skeleton_cache_key_covers_the_heading_type_hints() -> None:
    from app.survey.llm_cache import LlmResponseCache

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton("Some section text.", heading_type_hints=[("A", "Epic")])
    client.analyze_section_skeleton("Some section text.", heading_type_hints=[("B", "Epic")])
    assert call_count["n"] == 2  # different hints -- cache must not conflate them

    client.analyze_section_skeleton("Some section text.", heading_type_hints=[("A", "Epic")])
    assert call_count["n"] == 2  # same hints as the first call -- real cache hit


def test_analyze_section_skeleton_agentic_forwards_heading_type_hints_into_its_degraded_fallback_call() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "tools" in body:
            return httpx.Response(200, json={})
        captured["body"] = body
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton_agentic(
        "Some section text.", lambda query: (None, []),
        heading_type_hints=[("Target Handling", "Epic")],
    )

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "'Target Handling' (Epic)" in system_prompt


def test_requirement_row_hint_is_empty_for_no_rows() -> None:
    from app.survey.orchestrator_llm_client import _requirement_row_hint

    assert _requirement_row_hint(None) == ""
    assert _requirement_row_hint([]) == ""


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


def test_analyze_section_agentic_forces_a_final_answer_on_the_last_round_instead_of_returning_0_nodes() -> None:
    # Regression guard for a confirmed real cause of a branch silently
    # contributing 0 nodes: a model that kept calling query_kb right up to
    # the round budget previously fell straight into "exceeded
    # _MAX_TOOL_ROUNDS -- 0 nodes" with no final answer ever produced.
    # toolChoice:'none' on the last round tells the model tool use is off
    # the table, so a compliant model answers instead of calling a tool
    # again.
    from app.survey.orchestrator_llm_client import _MAX_TOOL_ROUNDS

    final_nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Grounded requirement.", "tags": []}]
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        body = json.loads(request.content)
        if body.get("toolChoice") == "none":
            # The forced-final round -- a compliant model answers.
            return httpx.Response(200, json={"content": json.dumps({"nodes": final_nodes})})
        return httpx.Response(
            200, json={"toolCalls": [{"id": "call-1", "function": {"name": "query_kb", "arguments": '{"query": "x"}'}}]}
        )

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, _, truncated = client.analyze_section_agentic("Some section text.", lambda query: (None, []))

    assert nodes == final_nodes
    assert truncated is False
    assert call_count["n"] == _MAX_TOOL_ROUNDS  # forced to answer on the last round, not a 5th call


def test_analyze_section_agentic_falls_back_to_analyze_section_when_a_model_ignores_tool_choice_none() -> None:
    # Defensive edge case: a model that contradicts toolChoice:'none' (still
    # emits tool_calls on the forced-final round) must not crash or silently
    # return 0 nodes -- falls back to one non-agentic analyze_section call
    # over the same section text instead.
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "tools" not in body:
            # The fallback analyze_section call -- no tools offered at all.
            return httpx.Response(200, json={"content": json.dumps({"nodes": [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Fallback requirement.", "tags": []}]})})
        return httpx.Response(
            200, json={"toolCalls": [{"id": "call-1", "function": {"name": "query_kb", "arguments": '{"query": "x"}'}}]}
        )

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, citations, truncated = client.analyze_section_agentic("Some section text.", lambda query: (None, []))

    assert nodes == [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Fallback requirement.", "tags": []}]
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


def test_analyze_section_agentic_parses_json_prefaced_with_conversational_prose() -> None:
    # Regression guard for a confirmed real job failure (qwen3.6:35b): the
    # agentic path gets a free-form chat reply, not a schema-constrained
    # completion, so the model prefaced its fenced JSON with prose instead
    # of returning bare JSON -- _strip_json_fence's old anchored-only regex
    # never matched this shape at all, and the whole SURVEY job crashed.
    final_nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "Grounded requirement.", "tags": []}]
    prefaced_content = (
        "Based on the analysis of Section 1, here is the synthesized work-item tree:\n\n"
        f"```json\n{json.dumps({'nodes': final_nodes})}\n```"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": prefaced_content})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, citations, _ = client.analyze_section_agentic("Some section text.", None)

    assert nodes == final_nodes


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


def test_analyze_section_agentic_bounds_at_max_tool_rounds_then_forces_a_final_answer() -> None:
    # A misbehaving model that keeps calling query_kb must not loop forever
    # -- _MAX_TOOL_ROUNDS is a hard ceiling on TOOL rounds -- but the last
    # round now forces toolChoice:'none' instead of just giving up, so a
    # compliant model still produces real nodes rather than [].
    from app.survey.orchestrator_llm_client import _MAX_TOOL_ROUNDS

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("toolChoice") == "none":
            return httpx.Response(200, json={"content": json.dumps({"nodes": []})})
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
    # _MAX_TOOL_ROUNDS - 1 real tool rounds (retrieve_fn actually called),
    # then the last round is forced to a final answer instead of a tool call.
    assert call_count["n"] == _MAX_TOOL_ROUNDS - 1
    assert len(citations) == _MAX_TOOL_ROUNDS - 1


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


# --- Part B stage 1 (skeleton) / stage 3 (content authoring) -----------------
# The two-call replacement for analyze_section's single do-everything call:
# structure first (no text, no ids), content afterwards against that already
# fixed structure. See llm_leveling._build_survey_skeleton_for_branch /
# _author_branch_content for the pipeline side of the same split.


def _skeleton_nodes() -> list[dict]:
    return [
        {"temp_id": "n0", "type": "Feature", "parent_temp_id": None, "title": "Display"},
        {"temp_id": "n1", "type": "Requirement", "parent_temp_id": "n0", "title": "HDR support"},
    ]


def test_analyze_section_skeleton_returns_structure_only_nodes() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": json.dumps({"nodes": _skeleton_nodes()})})

    nodes, truncated = client.analyze_section_skeleton("Display\nThe display shall support HDR.")

    assert nodes == _skeleton_nodes()
    assert truncated is False
    # The whole point of the split: nothing content-shaped comes back here.
    # 'customer_id' is deliberately absent from this check too -- it's
    # structural (see section_skeleton_schema), not content, so its
    # presence here wouldn't violate this test's own premise; this
    # fixture's nodes just don't happen to set it.
    assert all(not (set(n) & {"text", "description", "tags", "figure_ids", "table_ids"}) for n in nodes)


def test_analyze_section_skeleton_response_schema_asks_for_no_content_fields() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton("Some section text.")

    schema = captured["body"]["responseSchema"]["schema"]["properties"]["nodes"]["items"]
    item_properties = schema["properties"]
    # 'customer_id' is the one deliberate exception to "no content fields"
    # -- structural, not content, since it's the source document's OWN
    # identity for the row this node came from (see section_skeleton_schema
    # and _validated_skeleton_customer_id). Not required -- most nodes have
    # none.
    assert set(item_properties) == {"temp_id", "type", "parent_temp_id", "title", "customer_id"}
    assert "customer_id" not in schema["required"]
    assert item_properties["customer_id"] == {"type": ["string", "null"]}
    # Same deliberately-unbounded array as section_analysis_schema -- a
    # maxItems bound is the expensive case for Ollama's GBNF grammar.
    assert "maxItems" not in captured["body"]["responseSchema"]["schema"]["properties"]["nodes"]


def test_analyze_section_skeleton_reports_truncated_on_finish_reason_length() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(
        {"content": json.dumps({"nodes": _skeleton_nodes()}), "finishReason": "length"}
    )

    _, truncated = client.analyze_section_skeleton("Some section text.")
    assert truncated is True


def test_analyze_section_skeleton_prompt_carries_the_structural_steering_parameters() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton(
        "Some section text.", kb_context="Reference material.", whole_document=True, topic_count=7,
        table_group_hints=[("Media Buttons", "Feature")], expected_root_count=2,
    )

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "Reference material." in system_prompt
    assert "7" in system_prompt
    assert "Media Buttons" in system_prompt
    # Multi-root permission is a purely STRUCTURAL decision, so it belongs
    # to this stage rather than to content authoring.
    assert "2" in system_prompt


def test_analyze_section_skeleton_prompt_names_every_identified_requirement_row() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton(
        "Some section text.", requirement_row_hints=[("P-SENSOR-001#", "Time sync source")],
    )

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "P-SENSOR-001#" in system_prompt
    assert "1 individual row(s)" in system_prompt


def test_analyze_section_skeleton_omits_the_requirement_row_hint_when_none_supplied() -> None:
    # Mutation-safe: byte-identical prompt to before this parameter existed
    # for the common no-identified-rows case.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton("Some section text.")

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "individual row(s)" not in system_prompt


def test_analyze_section_skeleton_cache_key_covers_the_requirement_row_hints() -> None:
    from app.survey.llm_cache import LlmResponseCache

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton("Some section text.", requirement_row_hints=[("P-SENSOR-001#", "Time sync source")])
    client.analyze_section_skeleton("Some section text.", requirement_row_hints=[("P-SENSOR-002#", "Sync accuracy")])
    assert call_count["n"] == 2  # different hints -- cache must not conflate them

    client.analyze_section_skeleton("Some section text.", requirement_row_hints=[("P-SENSOR-001#", "Time sync source")])
    assert call_count["n"] == 2  # same hints as the first call -- real cache hit


def test_analyze_section_skeleton_cache_key_changed_with_the_prompt_and_schema_contract() -> None:
    from app.survey.llm_cache import cache_key

    key = cache_key(
        "analyze_section_skeleton.v2", "model", 4096, 40, 0.05,
        "text", None, False, None, None, None, None,
    )
    # A same-arguments key computed under the OLD operation string must
    # differ -- proves a pre-existing 24h-TTL cache entry from before this
    # change cannot be replayed as a hit against the new prompt/schema.
    old_key = cache_key(
        "analyze_section_skeleton", "model", 4096, 40, 0.05,
        "text", None, False, None, None, None,
    )
    assert key != old_key


def test_analyze_section_skeleton_agentic_forwards_requirement_row_hints_into_its_degraded_fallback_call() -> None:
    # The easy-to-miss path: a round that returns neither tool_calls nor
    # content degrades to the plain skeleton call -- confirmed here that
    # requirement_row_hints (like table_group_hints/expected_root_count)
    # is actually forwarded, not silently dropped on this specific branch.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "tools" in body:
            return httpx.Response(200, json={})
        captured["body"] = body
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton_agentic(
        "Some section text.", lambda query: (None, []),
        requirement_row_hints=[("P-SENSOR-001#", "Time sync source")],
    )

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "P-SENSOR-001#" in system_prompt


def test_analyze_section_skeleton_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "{}"}, expected_status=500)

    with pytest.raises(httpx.HTTPStatusError):
        client.analyze_section_skeleton("Some section text.")


def test_analyze_section_skeleton_agentic_calls_retrieve_fn_then_returns_skeleton() -> None:
    call_count = {"n": 0}
    retrieved: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200,
                json={
                    "toolCalls": [
                        {"id": "call-1", "function": {"name": "query_kb", "arguments": json.dumps({"query": "HDR"})}}
                    ]
                },
            )
        return httpx.Response(200, json={"content": json.dumps({"nodes": _skeleton_nodes()})})

    def retrieve_fn(query: str) -> tuple[str | None, list[dict]]:
        retrieved.append(query)
        return "HDR reference material.", [{"source_file": "hdr.pdf", "similarity": 0.9, "text": "HDR."}]

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, citations, truncated = client.analyze_section_skeleton_agentic("Some section text.", retrieve_fn)

    assert retrieved == ["HDR"]
    assert nodes == _skeleton_nodes()
    assert citations == [{"source_file": "hdr.pdf", "similarity": 0.9, "text": "HDR."}]
    assert truncated is False


def test_analyze_section_skeleton_agentic_sends_the_skeleton_schema_not_the_analysis_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"nodes": []})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.analyze_section_skeleton_agentic("Some section text.", lambda query: (None, []))

    assert "tools" in captured["body"]
    assert captured["body"]["responseSchema"]["name"] == "section_skeleton"


def test_analyze_section_skeleton_agentic_falls_back_to_the_non_agentic_skeleton_call() -> None:
    # Same degrade analyze_section_agentic has: a round that returns neither
    # tool_calls nor content falls back to one plain call, never to 0 nodes.
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(200, json={})
        return httpx.Response(200, json={"content": json.dumps({"nodes": _skeleton_nodes()})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    nodes, _, _ = client.analyze_section_skeleton_agentic("Some section text.", lambda query: (None, []))
    assert nodes == _skeleton_nodes()
    assert call_count["n"] == 2


def test_author_content_returns_description_and_tags_per_node() -> None:
    captured: dict = {}
    content = {
        "n0": {"description": "The display subsystem delivers picture output.", "tags": []},
        "n1": {"description": "The display shall support HDR.", "tags": ["functional"]},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps(content)})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    skeleton = {
        "n0": {"type": "Feature", "title": "Display", "parent_id": None},
        "n1": {"type": "Requirement", "title": "HDR support", "parent_id": "n0"},
    }
    result, truncated = client.author_content("Display\nThe display shall support HDR.", skeleton)

    assert result == content
    assert truncated is False
    # The already-decided skeleton crosses the wire alongside the section
    # text -- this call is given the tree, it does not re-derive one.
    user_payload = json.loads(captured["body"]["messages"][1]["content"])
    assert user_payload["nodes"] == skeleton
    assert user_payload["section"] == "Display\nThe display shall support HDR."
    system_prompt = captured["body"]["messages"][0]["content"]
    assert "FIXED" in system_prompt
    assert "2 node(s)" in system_prompt


def test_author_content_response_schema_asks_for_no_structural_fields() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.author_content("Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}})

    value_schema = captured["body"]["responseSchema"]["schema"]["additionalProperties"]
    assert set(value_schema["properties"]) == {"description", "tags"}


def test_author_content_prepends_kb_context_when_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.author_content(
        "Some section text.",
        {"n0": {"type": "Requirement", "title": "T", "parent_id": None}},
        kb_context="Grounding material the skeleton stage already pulled.",
    )

    assert "Grounding material the skeleton stage already pulled." in captured["body"]["messages"][0]["content"]


def test_author_content_reports_truncated_on_finish_reason_length() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "{}", "finishReason": "length"})

    _, truncated = client.author_content("Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}})
    assert truncated is True


def test_author_content_tolerates_a_non_object_response() -> None:
    # An omitted/degraded node is the CALLER's problem to degrade around
    # (see llm_leveling._author_branch_content) -- this method never
    # invents an entry, it just reports what came back.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[]"})

    result, _ = client.author_content("Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}})
    assert result == {}


def test_author_content_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "{}"}, expected_status=500)

    with pytest.raises(httpx.HTTPStatusError):
        client.author_content("Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}})


def _author_content_cached_client(handler) -> OrchestratorLlmClient:
    from app.survey.llm_cache import LlmResponseCache

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer",
        cache=LlmResponseCache(_CountingFakeRedis()),
    )
    client._transport = httpx.MockTransport(handler)
    return client


def test_author_content_cache_miss_then_hit_skips_the_second_llm_call() -> None:
    # Splitting generation in two doubled a document's per-branch call count,
    # and this is the LARGER half of the pair -- caching only the skeleton
    # call would leave a re-run paying full price for exactly the expensive
    # one. Same cache the analyze_section family already uses.
    content = {"n0": {"description": "The system shall do x.", "tags": []}}
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps(content)})

    client = _author_content_cached_client(handler)
    skeleton = {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}

    first_result, first_truncated = client.author_content("Some section text.", skeleton)
    second_result, second_truncated = client.author_content("Some section text.", skeleton)

    assert call_count == 1  # second call hit the cache, never reached the transport
    assert first_result == second_result == content
    assert first_truncated is second_truncated is False


def test_author_content_cache_never_stores_a_truncated_result() -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": "{}", "finishReason": "length"})

    client = _author_content_cached_client(handler)
    skeleton = {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}

    client.author_content("Some section text.", skeleton)
    client.author_content("Some section text.", skeleton)

    # A truncated answer is a known-incomplete one -- both calls must reach
    # the real transport rather than the second silently reusing it.
    assert call_count == 2


def test_author_content_cache_key_covers_the_skeleton_not_just_the_section_text() -> None:
    # The same section under a DIFFERENT decided tree is a genuinely
    # different request -- a cache keyed on section text alone would serve
    # branch A's content for branch B's structure.
    def handler(request: httpx.Request) -> httpx.Response:
        requested = json.loads(json.loads(request.content)["messages"][1]["content"])["nodes"]
        return httpx.Response(200, json={"content": json.dumps(
            {local_id: {"description": entry["title"], "tags": []} for local_id, entry in requested.items()}
        )})

    client = _author_content_cached_client(handler)

    first, _ = client.author_content("Same section text.", {"n0": {"type": "Requirement", "title": "First", "parent_id": None}})
    second, _ = client.author_content("Same section text.", {"n0": {"type": "Requirement", "title": "Second", "parent_id": None}})

    assert first == {"n0": {"description": "First", "tags": []}}
    assert second == {"n0": {"description": "Second", "tags": []}}  # not a stale hit from the first skeleton


def test_author_content_cache_key_differs_by_kb_context() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        system_prompt = json.loads(request.content)["messages"][0]["content"]
        grounded = "Grounding material." in system_prompt
        return httpx.Response(200, json={"content": json.dumps({"n0": {"description": str(grounded), "tags": []}})})

    client = _author_content_cached_client(handler)
    skeleton = {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}

    ungrounded, _ = client.author_content("Same section text.", skeleton)
    grounded, _ = client.author_content("Same section text.", skeleton, kb_context="Grounding material.")

    assert ungrounded["n0"]["description"] == "False"
    assert grounded["n0"]["description"] == "True"


_MAPPING_CANDIDATES = {
    "n0": {"type": "Feature", "title": "Display"},
    "n1": {"type": "Requirement", "title": "HDR support"},
}
_MAPPING_ITEMS = {
    "f0": {"kind": "figure", "section": "Display", "caption": "HDR tone-mapping curve"},
    "t0": {"kind": "table", "section": "Display", "caption": None, "columns": ["Signal", "Pin"]},
}


def test_map_figures_tables_returns_a_verdict_per_item() -> None:
    captured: dict = {}
    verdicts = {
        "f0": {"node_id": "n1", "escalate": False},
        "t0": {"node_id": None, "escalate": True},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps(verdicts)})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS)

    assert result == verdicts
    # Both halves cross the wire in ONE call -- the candidates to choose
    # from and every item being placed (batched, never per-figure).
    user_payload = json.loads(captured["body"]["messages"][1]["content"])
    assert user_payload["candidates"] == _MAPPING_CANDIDATES
    assert user_payload["items"] == _MAPPING_ITEMS
    assert "2 item(s)" in captured["body"]["messages"][0]["content"]


def test_map_figures_tables_response_schema_offers_all_three_outcomes() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS)

    value_schema = captured["body"]["responseSchema"]["schema"]["additionalProperties"]
    assert set(value_schema["properties"]) == {"node_id", "escalate"}
    # Nullable node_id + a separate boolean is what makes "matched",
    # "decorative" and "escalate" three checkable outcomes rather than one
    # sentinel string sharing the id space.
    assert value_schema["properties"]["node_id"]["type"] == ["string", "null"]
    assert value_schema["properties"]["escalate"]["type"] == "boolean"


def test_map_figures_tables_tolerates_a_non_object_response() -> None:
    # Every unanswered item is the CALLER's own escalate/exclude decision
    # (see llm_leveling._map_figures_tables_to_nodes) -- this method never
    # invents a verdict, it reports what came back.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "[]"})

    assert client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS) == {}


def test_map_figures_tables_raises_on_non_200_response() -> None:
    # The mapping STAGE is fail-open, but that degradation belongs to the
    # caller -- this method still raises like every other client method, so
    # the caller can tell a real failure apart from an empty verdict set.
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport({"content": "{}"}, expected_status=500)

    with pytest.raises(httpx.HTTPStatusError):
        client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS)


def test_map_figures_tables_cache_miss_then_hit_skips_the_second_llm_call() -> None:
    from app.survey.llm_cache import LlmResponseCache

    call_count = 0
    # A COMPLETE answer (one verdict per offered item) -- an incomplete one is
    # deliberately never cached, see the two tests below.
    verdicts = {
        "f0": {"node_id": "n1", "escalate": False},
        "t0": {"node_id": None, "escalate": False},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps(verdicts)})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer",
        cache=LlmResponseCache(_CountingFakeRedis()),
    )
    client._transport = httpx.MockTransport(handler)

    first = client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS)
    second = client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS)

    assert call_count == 1  # second call hit the cache, never reached the transport
    assert first == second == verdicts


def test_map_figures_tables_never_caches_a_truncated_response() -> None:
    # An unanswered item silently becomes an exclusion downstream -- caching
    # a truncated answer would make that loss permanent across every re-run
    # of the same document instead of getting a real answer on retry.
    from app.survey.llm_cache import LlmResponseCache

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={
            "content": json.dumps({"f0": {"node_id": "n1", "escalate": False}}),
            "finishReason": "length",
        })

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer",
        cache=LlmResponseCache(_CountingFakeRedis()),
    )
    client._transport = httpx.MockTransport(handler)

    client.map_figures_tables(_MAPPING_CANDIDATES, {"f0": _MAPPING_ITEMS["f0"]})
    client.map_figures_tables(_MAPPING_CANDIDATES, {"f0": _MAPPING_ITEMS["f0"]})

    assert call_count == 2


def test_map_figures_tables_never_caches_a_response_missing_items() -> None:
    # The other half of "incomplete": a response that came back short of what
    # was asked, with no finishReason to signal it.
    from app.survey.llm_cache import LlmResponseCache

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={
            "content": json.dumps({"f0": {"node_id": "n1", "escalate": False}}),  # t0 unanswered
        })

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer",
        cache=LlmResponseCache(_CountingFakeRedis()),
    )
    client._transport = httpx.MockTransport(handler)

    client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS)
    client.map_figures_tables(_MAPPING_CANDIDATES, _MAPPING_ITEMS)

    assert call_count == 2


def test_map_figures_tables_cache_key_covers_the_candidates_not_just_the_items() -> None:
    # The SAME items against a DIFFERENT candidate set is a genuinely
    # different request -- tier 1 (this branch's nodes) and tier 2 (the whole
    # document's) legitimately ask about the same item twice.
    from app.survey.llm_cache import LlmResponseCache

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(json.loads(request.content)["messages"][1]["content"])
        winner = sorted(body["candidates"])[0]
        return httpx.Response(200, json={"content": json.dumps(
            {item_id: {"node_id": winner, "escalate": False} for item_id in body["items"]}
        )})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer",
        cache=LlmResponseCache(_CountingFakeRedis()),
    )
    client._transport = httpx.MockTransport(handler)

    tier1 = client.map_figures_tables({"n1": {"type": "Requirement", "title": "A"}}, _MAPPING_ITEMS)
    tier2 = client.map_figures_tables({"n9": {"type": "Requirement", "title": "B"}}, _MAPPING_ITEMS)

    assert tier1["f0"]["node_id"] == "n1"
    assert tier2["f0"]["node_id"] == "n9"  # not a stale hit from the tier-1 candidate set


def test_post_chat_retries_a_500_then_succeeds(monkeypatch) -> None:
    # Regression: a real job lost 45+ minutes of prior work to a single
    # transient 500 from the LLM backend with zero retry anywhere in the
    # /llm/chat call chain. _post_chat now retries 429/5xx up to
    # _MAX_CHAT_RETRY_ATTEMPTS times before giving up.
    monkeypatch.setattr(orchestrator_llm_client_module.time, "sleep", lambda _seconds: None)
    call_count = {"n": 0}
    nodes = [{"temp_id": "n0", "type": "Requirement", "parent_temp_id": None, "text": "x", "tags": []}]

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] < 2:
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"content": json.dumps({"nodes": nodes})})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result, _ = client.analyze_section("Some section text.")
    assert result == nodes
    assert call_count["n"] == 2


def test_post_chat_gives_up_after_max_attempts_on_a_persistent_500(monkeypatch) -> None:
    monkeypatch.setattr(orchestrator_llm_client_module.time, "sleep", lambda _seconds: None)
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(500, json={"error": "boom"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    with pytest.raises(httpx.HTTPStatusError):
        client.analyze_section("Some section text.")
    assert call_count["n"] == orchestrator_llm_client_module._MAX_CHAT_RETRY_ATTEMPTS


def test_post_chat_does_not_retry_a_4xx(monkeypatch) -> None:
    # A 401 (bad bearer, non-transient) must fail fast -- retrying it just
    # burns the full backoff window (10s) for a request that will never
    # succeed.
    sleep_calls: list[float] = []
    monkeypatch.setattr(orchestrator_llm_client_module.time, "sleep", lambda seconds: sleep_calls.append(seconds))
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(401, json={"error": "unauthorized"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    with pytest.raises(httpx.HTTPStatusError):
        client.analyze_section("Some section text.")
    assert call_count["n"] == 1
    assert sleep_calls == []


# distill_title (300553 smart-title fallback, backing TitleDistillationClient) ----


def test_distill_title_parses_the_title_out_of_a_valid_json_response() -> None:
    response_json = {"content": '{"title": "Physical robustness"}'}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.distill_title("The unit shall survive a 1m drop onto concrete.", 256)
    assert result == "Physical robustness"


def test_distill_title_sends_temperature_zero_and_the_max_length_hint() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["temperature"] = body["temperature"]
        captured["user_content"] = json.loads(body["messages"][1]["content"])
        return httpx.Response(200, json={"content": '{"title": "T"}'})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.distill_title("some text", 100)
    assert captured["temperature"] == 0
    assert captured["user_content"] == {"text": "some text", "maxLength": 100}


def test_distill_title_strips_a_markdown_json_fence() -> None:
    response_json = {"content": '```json\n{"title": "Physical robustness"}\n```'}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    result = client.distill_title("some text", 256)
    assert result == "Physical robustness"


def test_distill_title_raises_on_malformed_json_content() -> None:
    response_json = {"content": "not valid json"}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _mock_transport(response_json)

    with pytest.raises(ValueError, match="malformed"):
        client.distill_title("some text", 256)
