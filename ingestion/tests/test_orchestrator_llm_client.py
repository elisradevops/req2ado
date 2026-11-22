import contextlib

# ingestion/tests/test_orchestrator_llm_client.py
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

import app.survey.orchestrator_llm_client as orchestrator_llm_client_module
from app.prompts.assembly import DataBlock, block_text, build_call
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import RequirementQualityIssue


def _judged(level: int, *findings: tuple[str, str]) -> dict:
    """One item's scoring answer as the model gives it: a level per built-in category and quoted findings."""
    return {
        "categories": [
            {"name": name, "level": level, "evidence": ""}
            for name in ("clarity", "testability", "completeness_as_requirement")
        ],
        "findings": [{"issue": issue, "quote": quote} for issue, quote in findings],
    }

# Any built call: for tests about the request around the messages, not the prompt.
_CALL = build_call("judge_duplicate_pair", blocks=[DataBlock("source", "user content")])


@pytest.fixture(autouse=True)
def _legacy_keyed_schemas(monkeypatch):
    """The schema-shape tests in this file check the original open-map schemas, which
    are only sent in keyed_schema_mode="legacy_map". The production default ("none",
    no strict schema on keyed passes) is covered by the tests at the end of the file,
    which switch the mode back explicitly."""
    monkeypatch.setattr(orchestrator_llm_client_module.settings, "keyed_schema_mode", "legacy_map")


def _mock_transport(response_json: dict, expected_status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/chat"
        return httpx.Response(expected_status, json=response_json)

    return httpx.MockTransport(handler)


def test_model_property_exposes_the_configured_per_job_override() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", model="qwen2.5:32b"
    )
    assert client.model == "qwen2.5:32b"


def test_model_property_is_none_when_no_override_was_configured() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    assert client.model is None


def test_score_requirements_for_document_sends_all_descriptions_in_one_call_per_vote() -> None:
    call_count = {"n": 0}
    response_body = {
        "n0": _judged(4),
        "n1": _judged(1, ("vague_term", "user-friendly")),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        sent = json.loads(block_text(json.loads(request.content)["messages"][1]["content"]))
        assert set(sent) == {"n0", "n1"}
        return httpx.Response(200, json={"content": json.dumps(response_body)})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    result = client.score_requirements_for_document(
        {
            "n0": "The unit shall power on within 2 seconds.",
            "n1": "The unit shall be user-friendly.",
        }
    )

    assert result["n0"]["score"] == 100 and result["n0"]["issues"] == []
    # Level 1 on clarity and testability states ambiguous and not_testable; completeness 1 states fragment and gates the score.
    assert result["n1"]["score"] == 6
    assert result["n1"]["issues"] == ["ambiguous", "fragment", "not_testable", "vague_term"]
    assert call_count["n"] == 2  # two votes, each one call with every description


def test_score_requirements_for_document_sends_criteria_context_as_a_criteria_block_when_supplied() -> (
    None
):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"content": json.dumps({"n0": {"score": 90, "issues": []}})}
        )

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document(
        {"n0": "The unit shall power on within 2 seconds."},
        criteria_context="- vague_term: terms like 'fast' have no objective measure.",
    )

    system_prompt = captured["body"]["messages"][0]["content"]
    criteria = block_text(captured["body"]["messages"][1]["content"], "criteria")
    assert criteria == "- vague_term: terms like 'fast' have no objective measure."
    assert "terms like 'fast' have no objective measure" not in system_prompt
    assert "cite them in your judgment" in system_prompt


def test_score_requirements_for_document_omits_criteria_context_section_when_not_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"content": json.dumps({"n0": {"score": 90, "issues": []}})}
        )

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "retrieved as most relevant" not in system_prompt


def test_score_requirements_for_document_strips_a_markdown_json_fence() -> None:
    response_body = {"n0": _judged(4)}
    response_json = {"content": "```json\n" + json.dumps(response_body) + "\n```"}
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(response_json)

    result = client.score_requirements_for_document({"n0": "text"})
    assert result["n0"]["score"] == 100


def test_score_requirements_for_document_raises_on_malformed_json() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "not json"})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.score_requirements_for_document({"n0": "text"})


def test_score_requirements_for_document_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "{}"}, expected_status=429)

    with pytest.raises(httpx.HTTPStatusError):
        client.score_requirements_for_document({"n0": "text"})


def test_score_requirements_for_document_parses_valid_json_response() -> None:
    response_json = {"content": json.dumps({"0": _judged(3, ("vague_term", "fast"))})}
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(response_json)

    result = client.score_requirements_for_document({"0": "The system shall be fast."})
    assert result == {
        "0": {
            "score": 56,  # mean(75, 75) gated by completeness 3 of 4
            "issues": ["vague_term"],
            "categoryScores": {"clarity": 75, "testability": 75, "completeness_as_requirement": 75},
            "confidence": "high",
        }
    }


def test_score_requirements_for_document_sends_temperature_zero() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["temperature"] = body["temperature"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", num_ctx=32768
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text"})

    assert captured["body"]["numCtx"] == 32768


def test_score_requirements_for_document_omits_num_ctx_when_not_configured() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text"})

    assert "numCtx" not in captured["body"]


def test_score_requirements_for_document_forwards_top_k_and_min_p_when_configured() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", top_k=50, min_p=0.05
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text"})

    assert captured["body"]["topK"] == 50
    assert captured["body"]["minP"] == 0.05


def test_score_requirements_for_document_prompt_states_the_exact_expected_entry_count() -> None:
    # Regression guard, same confirmed-live pattern as _whole_document_hint/
    # _branch_topic_hint: a concrete, countable completeness instruction,
    # not just "never invent a node_id" -- addresses the real, already-
    # observed "no valid score for N node(s)" failure mode.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        # The first request only: an empty answer is followed by one retry of the ids it left out.
        captured.setdefault("body", json.loads(request.content))
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text", "n1": "text2", "n2": "text3"})

    system_prompt = captured["body"]["messages"][0]["content"]
    assert "exactly 3 node_id(s)" in system_prompt
    assert "exactly 3 entries" in system_prompt


def test_score_requirements_for_document_raises_on_malformed_json_content() -> None:
    response_json = {"content": "not valid json"}
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(response_json)

    with pytest.raises(ValueError, match="malformed"):
        client.score_requirements_for_document({"0": "text"})


def test_score_requirements_for_document_repairs_a_bare_unescaped_quote_inside_a_string_value() -> (
    None
):
    # Confirmed real job failure (AirPro Backplane ICD, job d8cd0779): the
    # model embedded literal, unescaped double quotes inside a string value
    # for emphasis -- e.g. `the "Power-ON" Event` -- breaking the JSON
    # string mid-value. None of the three narrow, positional tolerances in
    # _parse_json_object (missing outer brace / missing node-object brace)
    # can repair this shape (it needs re-escaping, not a missing brace) --
    # only the general-purpose json_repair fallback reaches it. Previously
    # this raised "malformed JSON" and failed the whole job.
    raw_broken_json = (
        '{"n0": {"categories": [{"name": "clarity", "level": 2, '
        '"evidence": "the shall include the "Power-ON" Event function"}], "findings": []}}'
    )
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": raw_broken_json})

    result = client.score_requirements_for_document({"n0": "text"})
    assert result["n0"]["score"] == 50


def test_score_requirements_for_document_frames_kb_context_as_an_authoritative_rubric() -> None:
    # Scoring's kb_context framing is deliberately STRONGER than the
    # grounding call sites' "may be incomplete or irrelevant" wording -- an
    # org's own ingested requirements-writing standard should be treated as
    # the authoritative rubric for judging these requirements, not generic
    # background material the model may or may not use.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        messages = json.loads(request.content)["messages"]
        captured["system_prompt"], captured["user"] = messages[0]["content"], messages[1]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    from app.kb.profile import RubricText

    client.score_requirements_for_document(
        {"0": "text"}, kb_context=RubricText("Org rule: always specify units.")
    )
    # The framing is an instruction; the organization's rubric itself is a <rubric> block of the user message, with its own
    # authority (not the "may be irrelevant" reference framing).
    assert "The <rubric> block is this organization's own standard" in captured["system_prompt"]
    assert "authoritative for the judgment it describes" in captured["system_prompt"]
    assert "Org rule: always specify units." not in captured["system_prompt"]
    assert block_text(captured["user"], "rubric") == "Org rule: always specify units."
    assert "EARS" in captured["system_prompt"] or "INCOSE" in captured["system_prompt"]


def test_score_requirements_for_document_prompt_unchanged_when_kb_context_is_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})
    assert "Reference material from the knowledge base" not in captured["system_prompt"]


def test_extract_quality_checklist_parses_a_real_list() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(
        {"content": json.dumps(["Necessary", "Unambiguous", "Verifiable"])}
    )

    result = client.extract_quality_checklist("3.3 Customer requirement quality checklist\n...")
    assert result == ["Necessary", "Unambiguous", "Verifiable"]


def test_extract_quality_checklist_reads_the_object_the_schema_asks_for() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(
        {"content": json.dumps({"categories": ["Necessary", "Unambiguous"]})}
    )
    assert client.extract_quality_checklist("doc") == ["Necessary", "Unambiguous"]
    client._transport = _mock_transport({"content": json.dumps({"categories": []})})
    assert client.extract_quality_checklist("doc") == []


def test_the_checklist_schema_has_an_object_root_for_azure_strict_mode() -> None:
    from app.survey._response_schemas import checklist_extraction_schema

    schema = checklist_extraction_schema()["schema"]
    assert schema["type"] == "object" and schema["required"] == ["categories"]
    assert _strict_violations(schema) == []


def test_extract_quality_checklist_returns_empty_list_when_document_has_no_checklist() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "[]"})

    result = client.extract_quality_checklist("Some unrelated document about airplanes.")
    assert result == []


def test_extract_quality_checklist_raises_on_a_non_list_response() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": '{"not": "a list"}'})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.extract_quality_checklist("text")


def test_extract_quality_checklist_raises_on_a_list_with_non_string_items() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.extract_quality_checklist("x" * 50_000)

    user_content = captured["body"]["messages"][1]["content"]
    assert len(user_content) < 50_000


def test_extract_quality_checklist_falls_back_to_empty_when_too_many_items() -> None:
    # A nonsense/runaway extraction (way more than a real checklist would
    # ever have) is treated as "no checklist found" rather than stored and
    # replayed into every future scoring prompt.
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps([f"Item {i}" for i in range(40)])})

    result = client.extract_quality_checklist("text")
    assert result == []


def test_extract_quality_checklist_falls_back_to_empty_when_only_one_item_survives() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps(["Solo item"])})

    result = client.extract_quality_checklist("text")
    assert result == []


def test_extract_quality_checklist_drops_an_oversized_item_but_keeps_the_rest() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    oversized = "x" * 500
    client._transport = _mock_transport(
        {"content": json.dumps(["Necessary", "Unambiguous", "Verifiable", oversized])}
    )

    result = client.extract_quality_checklist("text")
    assert result == ["Necessary", "Unambiguous", "Verifiable"]


def test_extract_quality_checklist_dedups_case_insensitively_preserving_first_seen_order_and_casing() -> (
    None
):
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(
        {
            "content": json.dumps(
                ["Necessary", "NECESSARY", "Unambiguous", "unambiguous", "Verifiable"]
            )
        }
    )

    result = client.extract_quality_checklist("text")
    assert result == ["Necessary", "Unambiguous", "Verifiable"]


def test_extract_quality_checklist_well_formed_eleven_item_list_passes_through_unchanged() -> None:
    items = [
        "Necessary",
        "Unambiguous",
        "Verifiable",
        "Complete",
        "Consistent",
        "Feasible",
        "Traceable",
        "Correct",
        "Singular",
        "Testable",
        "Ranked",
    ]
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.extract_quality_checklist("text")

    assert captured["body"]["temperature"] == 0
    assert captured["body"]["think"] is False


def test_extract_quality_checklist_definitions_parses_a_real_mapping() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(
        {
            "content": json.dumps(
                {"Necessary": "The requirement states something not already satisfied."}
            )
        }
    )

    result = client.extract_quality_checklist_definitions(
        "3.3 Customer requirement quality checklist\n...",
        ["Necessary", "Unambiguous"],
    )
    assert result == {"Necessary": "The requirement states something not already satisfied."}


def test_extract_quality_checklist_definitions_returns_empty_dict_with_no_category_names() -> None:
    # Deliberately never issues a call at all when the first extraction
    # pass (extract_quality_checklist) found no checklist -- nothing to ask
    # a definition for, see this method's own docstring.
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(
        lambda request: (_ for _ in ()).throw(AssertionError("should not be called"))
    )

    result = client.extract_quality_checklist_definitions("text", [])
    assert result == {}


def test_extract_quality_checklist_definitions_drops_a_key_not_in_category_names() -> None:
    # Confirmed real safeguard: a model that hallucinates or misspells a
    # category name in its response must never introduce a NEW key the
    # scores dict never had -- only the FIXED, already-decided names given
    # to this call are ever accepted.
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(
        {
            "content": json.dumps(
                {"Necessary": "Real def.", "Made Up Category": "Should be dropped."}
            )
        }
    )

    result = client.extract_quality_checklist_definitions("text", ["Necessary", "Unambiguous"])
    assert result == {"Necessary": "Real def."}


def test_extract_quality_checklist_definitions_matches_case_insensitively_but_keys_by_canonical_name() -> (
    None
):
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps({"NECESSARY": "Real def."})})

    result = client.extract_quality_checklist_definitions("text", ["Necessary"])
    assert result == {"Necessary": "Real def."}


def test_extract_quality_checklist_definitions_truncates_an_oversized_definition() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    oversized = "x" * 500
    client._transport = _mock_transport({"content": json.dumps({"Necessary": oversized})})

    result = client.extract_quality_checklist_definitions("text", ["Necessary"])
    assert result == {"Necessary": oversized[:280]}


def test_extract_quality_checklist_definitions_drops_empty_and_non_string_values() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(
        {"content": json.dumps({"Necessary": "   ", "Unambiguous": 5})}
    )

    result = client.extract_quality_checklist_definitions("text", ["Necessary", "Unambiguous"])
    assert result == {}


def test_extract_quality_checklist_definitions_raises_on_a_non_object_response() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "[1, 2, 3]"})

    with pytest.raises(ValueError, match="malformed JSON"):
        client.extract_quality_checklist_definitions("text", ["Necessary"])


def test_infer_trace_links_now_sends_a_response_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"links": []})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.infer_trace_links([], [])

    assert "responseSchema" in captured["body"]
    schema = captured["body"]["responseSchema"]["schema"]
    assert schema["type"] == "object"
    assert schema["properties"]["links"]["type"] == "array"
    assert "maxItems" not in schema["properties"]["links"]
    assert "evidence_quote" in schema["properties"]["links"]["items"]["required"]


def test_infer_trace_links_sends_nodes_and_catalog_returns_parsed_links() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        # The catalog is data: the <link_types> block of the user message, never the system prompt.
        assert "Elisra.CoveredBy-Forward" in block_text(
            body["messages"][1]["content"], "link_types"
        )
        assert "Elisra.CoveredBy-Forward" not in body["messages"][0]["content"]
        return httpx.Response(
            200,
            json={
                "content": json.dumps(
                    {
                        "links": [
                            {
                                "source_node_id": "1",
                                "target_ref": "0",
                                "reference_name": "Elisra.CoveredBy-Forward",
                            }
                        ]
                    }
                )
            },
        )

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    result = client.infer_trace_links(
        nodes=[
            {
                "node_id": "0",
                "type": "Requirement",
                "title": "Sys Req",
                "text": "The system shall X.",
            },
            {
                "node_id": "1",
                "type": "Requirement",
                "title": "Cust Req",
                "text": "The customer requires X.",
            },
        ],
        link_type_catalog=[
            {
                "reference_name": "Elisra.CoveredBy-Forward",
                "name": "Covered by",
                "semantic_hint": "system req covers customer req",
            },
        ],
    )

    assert result == [
        {"source_node_id": "1", "target_ref": "0", "reference_name": "Elisra.CoveredBy-Forward"}
    ]


def test_infer_trace_links_raises_on_malformed_json() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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
    unfenced_prefaced_content = preamble + json.dumps({"links": [link]})
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": unfenced_prefaced_content})

    result = client.infer_trace_links(nodes=[], link_type_catalog=[])

    assert result == [link]


def test_infer_trace_links_with_no_catalog_still_sends_a_valid_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["messages"][1]["content"]  # user content present
        return httpx.Response(200, json={"content": json.dumps({"links": []})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.infer_trace_links(nodes=[], link_type_catalog=[])

    system_prompt = captured["system_prompt"].lower()
    assert "external" in system_prompt or "customer" in system_prompt


def test_score_requirements_for_document_includes_an_issues_enum_schema_with_additional_properties() -> (
    None
):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "The unit shall survive a 1m drop."})

    schema = captured["body"]["responseSchema"]["schema"]
    # Dynamic node_id-keyed object -- must use additionalProperties, not a
    # fixed properties set, since keys are runtime node_ids.
    assert "additionalProperties" in schema
    findings = schema["additionalProperties"]["properties"]["findings"]["items"]["properties"]
    # Every issue but conflicting_value, which only duplicate detection can state (it needs two items).
    assert set(findings["issue"]["enum"]) == {i.value for i in RequirementQualityIssue} - {
        "conflicting_value"
    }


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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "The unit shall survive a 1m drop."})

    entry_schema = captured["body"]["responseSchema"]["schema"]["additionalProperties"]
    assert "categories" in entry_schema["required"]
    category = entry_schema["properties"]["categories"]["items"]["properties"]
    # The category name is free text (an organization's own names), the level an integer whose 0-4 range code checks.
    assert category["name"] == {"type": "string"} and category["level"] == {"type": "integer"}


def test_score_requirements_for_document_prompt_explains_all_five_categories() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})

    prompt = captured["system_prompt"]
    assert "completeness_as_requirement" in prompt
    for issue in (
        "not_a_requirement",
        "fragment",
        "placeholder",
        "open_item_tbd",
        "rationale_as_requirement",
    ):
        assert issue in prompt
    assert "conflicting_value" not in prompt  # duplicate detection states it, from two items


def test_score_requirements_for_document_derives_dynamic_categories_when_kb_context_is_present() -> (
    None
):
    # Confirmed real gap fixed here (user-reported): with a real ingested KB
    # standard, the prompt must ask the model to derive categoryScores KEYS
    # from that material's own checklist instead of always locking to the
    # generic clarity/testability/atomicity/style/rationale 5-tuple.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document(
        {"0": "text"}, kb_context="Org standard: Necessary, Unambiguous, Verifiable."
    )

    prompt = captured["system_prompt"]
    assert "the quality checklist the organization's knowledge-base material defines" in prompt
    # Determinism instruction: same category set across every node in the batch.
    assert "Decide the names ONCE and use the same set" in prompt
    # Still documents the fallback for when the material has no clear checklist.
    assert "use clarity, testability, atomicity, style and rationale instead" in prompt


def test_score_requirements_for_document_uses_fixed_categories_without_kb_context() -> None:
    # Backward-compat: no kb_context -> byte-identical fixed 5-category
    # instruction, no "derive"/dynamic-key language at all.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["system_prompt"] = json.loads(request.content)["messages"][0]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"0": "text"})

    prompt = captured["system_prompt"]
    assert "EXACTLY SIX" in prompt
    assert "Decide the names ONCE" not in prompt


def test_score_requirements_for_document_with_fixed_checklist_and_kb_context_drops_derive_language() -> (
    None
):
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
        messages = json.loads(request.content)["messages"]
        captured["system_prompt"], captured["user"] = messages[0]["content"], messages[1]["content"]
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document(
        {"0": "text"},
        kb_context="Org standard: Necessary, Unambiguous, Verifiable.",
        category_checklist=["Necessary", "Unambiguous", "Verifiable"],
    )

    prompt = captured["system_prompt"]
    assert "Decide the names ONCE" not in prompt
    assert "taking your category names from its checklist" not in prompt
    assert "do not add, omit or rename any" in prompt
    assert "Necessary" in block_text(captured["user"], "category_names")


def test_chat_json_forwards_top_k_and_min_p_when_configured() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"ok": True})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", top_k=50, min_p=0.05
    )
    client._transport = httpx.MockTransport(handler)

    client._chat_json(_CALL, client._params())

    assert captured["body"]["topK"] == 50
    assert captured["body"]["minP"] == 0.05


def test_chat_json_omits_top_k_and_min_p_when_not_configured() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"ok": True})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client._chat_json(_CALL, client._params())

    assert "topK" not in captured["body"]
    assert "minP" not in captured["body"]


def test_chat_json_omits_response_schema_when_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client._chat_json(_CALL, client._params(schema=None))

    assert "responseSchema" not in captured["body"]


def test_chat_json_respects_a_custom_max_tokens() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client._chat_json(_CALL, client._params(schema={"type": "object"}, max_tokens=2000))

    assert captured["body"]["maxTokens"] == 2000


def test_title_and_tags_for_rows_sends_the_closed_tag_vocabulary_and_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        # First request only: an empty answer makes the keyed call retry the omitted ids, and
        # this test is about the request for the full set.
        captured.setdefault("body", json.loads(request.content))
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.title_and_tags_for_rows({"det0_h1": 'Size: 3U 1"', "det0_h2": "Over-current"})

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
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(response_json)

    result = client.title_and_tags_for_rows({"det0_h1": 'Size: 3U 1"'})
    assert result["det0_h1"]["title"] == "COTS power supply form factor"
    assert result["det0_h1"]["tags"] == ["interface"]


def test_synthesize_leaf_requirements_sends_context_and_schema() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.synthesize_leaf_requirements(
        {"det0_h1": {"text": 'Size: 3U 1"', "context": "Power Supply"}}
    )

    body = captured["body"]
    assert json.loads(block_text(body["messages"][1]["content"])) == {
        "det0_h1": {"text": 'Size: 3U 1"', "context": "Power Supply"}
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
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(response_json)

    result = client.synthesize_leaf_requirements(
        {"det0_h1": {"text": 'Size: 3U 1"', "context": "Power Supply"}}
    )
    assert result["det0_h1"]["text"] == "The COTS power supply shall have a 3U, 1-inch form factor."
    assert result["det0_h1"]["title"] == "COTS power supply form factor"
    assert result["det0_h1"]["tags"] == ["interface"]


def test_judge_parameter_pairs_sends_each_pair_and_the_generated_items_schema(monkeypatch) -> None:
    monkeypatch.setattr(orchestrator_llm_client_module.settings, "keyed_schema_mode", "array")
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.setdefault("first", json.loads(request.content))  # an empty answer falls back to a prompt-only call
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.judge_parameter_pairs({"p0": {"a": "מתח 28V", "b": "מתח 24V"}})

    body = captured["first"]
    system, user = body["messages"][0]["content"], body["messages"][1]["content"]
    assert "same_parameter" in system and "values_agree" in system and "exactly 1 pair(s)" in system
    assert '{"p0": {"a": "מתח 28V", "b": "מתח 24V"}}' in user  # untrusted text only in the user block, unescaped
    entry = body["responseSchema"]["schema"]["properties"]["items"]["items"]
    assert entry["properties"]["same_parameter"]["enum"] == ["yes", "no", "uncertain"]
    assert entry["properties"]["values_agree"]["enum"] == ["yes", "no", "uncertain"]
    assert body["temperature"] == 0


def test_judge_parameter_pairs_keeps_only_answers_in_the_verdict_vocabulary() -> None:
    answer = {
        "p0": {"same_parameter": "yes", "values_agree": "no"},
        "p1": {"same_parameter": "probably", "values_agree": "no"},
    }
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps(answer)})

    result = client.judge_parameter_pairs(
        {"p0": {"a": "at least 85%", "b": "at-least 93%"}, "p1": {"a": "x", "b": "y"}}
    )

    assert dict(result) == {"p0": {"same_parameter": "yes", "values_agree": "no"}}
    assert result.missing == ["p1"]


def _strict_violations(schema: dict) -> list[str]:
    """The shared portable-schema rules (app.survey.portable_schema), one definition for every schema test."""
    from app.survey.portable_schema import portable_schema_violations

    return portable_schema_violations(schema)


def test_post_scoring_schemas_follow_the_strict_vendor_rules() -> None:
    from app.survey import _response_schemas as rs

    for build in (
        rs.duplicate_pair_verdict_schema,
        rs.trace_links_schema,
    ):
        assert _strict_violations(build()["schema"]) == [], build.__name__


def test_infer_trace_links_sends_response_schema_even_with_a_nonempty_catalog() -> None:
    # Same call this repo once avoided a maxItems-bounded top-level array
    # schema for (the GBNF array-wedge risk, up to ~200 nodes across a
    # whole tree) -- but a schema IS now sent regardless of catalog size,
    # via trace_links_schema()'s object-wrapped {"links": [...]} shape
    # (no maxItems, so it doesn't hit that cost). The reference_name-not-
    # in-catalog filter in llm_leveling.py stays as defense-in-depth on
    # top of this.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"links": []})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    catalog = [
        {"reference_name": "Elisra.CoveredBy-Forward", "name": "Covered by"},
        {"reference_name": "System.LinkTypes.Related", "name": "Related"},
    ]
    client.infer_trace_links(
        nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}],
        link_type_catalog=catalog,
    )

    assert "responseSchema" in captured["body"]
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
        return httpx.Response(200, json={"content": json.dumps({"links": []})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", num_ctx=32768
    )
    client._transport = httpx.MockTransport(handler)

    client.infer_trace_links(
        nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}],
        link_type_catalog=[],
    )

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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", num_ctx=32768
    )
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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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
    user_content = json.loads(block_text(captured["body"]["messages"][1]["content"]))
    assert user_content["snippets"]["0"]["source_file"] == "relevant.docx"


def test_infer_trace_links_sends_response_schema_when_catalog_is_empty() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({"links": []})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.infer_trace_links(
        nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}],
        link_type_catalog=[],
    )

    assert "responseSchema" in captured["body"]


def test_infer_trace_links_orders_catalog_native_types_first() -> None:
    # Task 5: native ADO link types (reference names starting with System. or
    # Microsoft.VSTS.) should be ordered first in the catalog, followed by
    # custom org-defined types. This ensures the model prefers native types
    # when they fit the relationship.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "[]"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    # Input catalog: custom type first, native type second
    catalog = [
        {"reference_name": "Elisra.CoveredBy-Forward", "name": "Covered by"},
        {"reference_name": "System.LinkTypes.Affects-Forward", "name": "Affects"},
    ]
    client.infer_trace_links(
        nodes=[{"node_id": "0", "type": "Requirement", "title": "t", "text": "x"}],
        link_type_catalog=catalog,
    )

    link_types = block_text(captured["body"]["messages"][1]["content"], "link_types")
    # Native type should appear before custom type in the catalog block
    native_index = link_types.index("System.LinkTypes.Affects-Forward")
    custom_index = link_types.index("Elisra.CoveredBy-Forward")
    assert native_index < custom_index, (
        "Native types should be ordered before custom types in the catalog"
    )


# --- analyze_section / analyze_section_agentic (§2b/§5b holistic redesign) ---


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


def test_score_requirements_for_document_cache_miss_then_hit_skips_the_second_llm_call() -> None:
    from app.survey.llm_cache import LlmResponseCache

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"content": json.dumps({"n0": _judged(3)})})

    cache = LlmResponseCache(_CountingFakeRedis())
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache
    )
    client._transport = httpx.MockTransport(handler)

    first = client.score_requirements_for_document({"n0": "The unit shall survive a drop."})
    second = client.score_requirements_for_document({"n0": "The unit shall survive a drop."})

    assert call_count == 2  # one per vote, the first time only
    assert first["n0"]["score"] == 56
    assert second == first


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

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "text"})

    assert captured["body"]["think"] is False
    assert captured["body"]["maxTokens"] == 20000


# --- Part B stage 1 (skeleton) / stage 3 (content authoring) -----------------
# The two-call replacement for analyze_section's single do-everything call:
# structure first (no text, no ids), content afterwards against that already
# fixed structure. See llm_leveling._build_survey_skeleton_for_branch /
# _author_branch_content for the pipeline side of the same split.


def test_author_content_returns_description_and_tags_per_node() -> None:
    captured: dict = {}
    content = {
        "n0": {"description": "The display subsystem delivers picture output.", "tags": []},
        "n1": {"description": "The display shall support HDR.", "tags": ["functional"]},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps(content)})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
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
    user_payload = json.loads(block_text(captured["body"]["messages"][1]["content"]))
    assert user_payload["nodes"] == skeleton
    assert user_payload["section"] == "Display\nThe display shall support HDR."
    system_prompt = captured["body"]["messages"][0]["content"]
    assert "The tree is fixed" in system_prompt
    assert "2 node(s)" in system_prompt


def test_author_content_response_schema_asks_for_no_structural_fields() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.author_content(
        "Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}
    )

    value_schema = captured["body"]["responseSchema"]["schema"]["additionalProperties"]
    assert set(value_schema["properties"]) == {"description", "tags"}


def test_author_content_sends_kb_context_as_a_reference_block_when_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.author_content(
        "Some section text.",
        {"n0": {"type": "Requirement", "title": "T", "parent_id": None}},
        kb_context="Grounding material the skeleton stage already pulled.",
    )

    user = captured["body"]["messages"][1]["content"]
    assert block_text(user, "reference") == "Grounding material the skeleton stage already pulled."
    assert "Grounding material" not in captured["body"]["messages"][0]["content"]


def test_author_content_reports_truncated_on_finish_reason_length() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "{}", "finishReason": "length"})

    _, truncated = client.author_content(
        "Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}
    )
    assert truncated is True


def test_author_content_tolerates_a_non_object_response() -> None:
    # An omitted/degraded node is the CALLER's problem to degrade around
    # (see llm_leveling._author_branch_content) -- this method never
    # invents an entry, it just reports what came back.
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "[]"})

    result, _ = client.author_content(
        "Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}
    )
    assert result == {}


def test_author_content_raises_on_non_200_response() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "{}"}, expected_status=500)

    with pytest.raises(httpx.HTTPStatusError):
        client.author_content(
            "Some section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}
        )


def _author_content_cached_client(handler) -> OrchestratorLlmClient:
    from app.survey.llm_cache import LlmResponseCache

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal",
        bearer_token="test-bearer",
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
        requested = json.loads(block_text(json.loads(request.content)["messages"][1]["content"]))[
            "nodes"
        ]
        return httpx.Response(
            200,
            json={
                "content": json.dumps(
                    {
                        local_id: {"description": entry["title"], "tags": []}
                        for local_id, entry in requested.items()
                    }
                )
            },
        )

    client = _author_content_cached_client(handler)

    first, _ = client.author_content(
        "Same section text.", {"n0": {"type": "Requirement", "title": "First", "parent_id": None}}
    )
    second, _ = client.author_content(
        "Same section text.", {"n0": {"type": "Requirement", "title": "Second", "parent_id": None}}
    )

    assert first == {"n0": {"description": "First", "tags": []}}
    assert second == {
        "n0": {"description": "Second", "tags": []}
    }  # not a stale hit from the first skeleton


def test_author_content_cache_key_differs_by_kb_context() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        user = json.loads(request.content)["messages"][1]["content"]
        grounded = block_text(user, "reference") == "Grounding material."
        return httpx.Response(
            200, json={"content": json.dumps({"n0": {"description": str(grounded), "tags": []}})}
        )

    client = _author_content_cached_client(handler)
    skeleton = {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}

    ungrounded, _ = client.author_content("Same section text.", skeleton)
    grounded, _ = client.author_content(
        "Same section text.", skeleton, kb_context="Grounding material."
    )

    assert ungrounded["n0"]["description"] == "False"
    assert grounded["n0"]["description"] == "True"


# --- Characterization tests for the SectionAnalysisOptions refactor ---
# These pin down the EXACT outgoing payload, the EXACT cache key and one
# undocumented behavioral asymmetry, so collapsing the six steering
# parameters into a dataclass can be proven byte-identical rather than
# assumed to be. They are deliberately written against the pre-refactor
# signature and must keep passing, unchanged in intent, afterwards.


# --- X-Req2Ado-User-Id threading (per-user Open WebUI credential routing) ---
#
# The orchestrator's /llm/chat, /llm/vision, /llm/show, /llm/embed routes now
# require an X-Req2Ado-User-Id header identifying which user's vaulted Open
# WebUI token/model to use -- there is no shared/global fallback credential
# any more, and a request with a valid bearer token but a missing/unknown
# header is rejected with 401 (see llm.controller.ts). `user_id` is threaded
# as a per-call parameter through every public method down to _post_chat --
# deliberately NEVER stored on `self`, since this class is constructed as a
# module-level singleton shared across every concurrent request the process
# handles (see main.py's _dedup_judge_client/_checklist_client). Storing it
# on the instance would leak one user's identity into a concurrent request
# from a different user.


def test_score_requirements_for_document_sends_the_x_req2ado_user_id_header_when_supplied() -> None:
    captured_headers: dict[str, str | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_headers["value"] = request.headers.get("x-req2ado-user-id")
        return httpx.Response(200, json={"content": json.dumps({})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "The unit shall power on."}, user_id="user-123")

    assert captured_headers["value"] == "user-123"


def test_score_requirements_for_document_omits_the_x_req2ado_user_id_header_when_not_supplied() -> (
    None
):
    # Omitted entirely (never sent as an empty string) when user_id is None --
    # mirrors how every other optional field in this module is conditionally
    # included.
    captured_headers: dict[str, bool] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_headers["present"] = "x-req2ado-user-id" in request.headers
        return httpx.Response(200, json={"content": json.dumps({})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.score_requirements_for_document({"n0": "The unit shall power on."})

    assert captured_headers["present"] is False


def test_show_model_sends_the_x_req2ado_user_id_header_when_supplied() -> None:
    # show_model is the one method with its own raw httpx call (not routed
    # through _post_chat/_chat_json) -- same header-threading contract,
    # verified separately since it builds its own headers dict.
    captured_headers: dict[str, str | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/llm/show"
        captured_headers["value"] = request.headers.get("x-req2ado-user-id")
        return httpx.Response(200, json={"contextLength": 32000, "capabilities": []})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.show_model("qwen3:4b", user_id="user-456")

    assert captured_headers["value"] == "user-456"


def test_shared_singleton_client_sends_the_correct_distinct_user_id_header_for_each_concurrent_call() -> (
    None
):
    """The single most important regression test for the concurrency hazard
    this task exists to close: a module-level-singleton-shaped client
    instance (mirroring main.py's _dedup_judge_client/_checklist_client --
    ONE OrchestratorLlmClient shared across every concurrent request the
    process handles) must send the CORRECT, per-call user_id header for two
    concurrent calls made with two DIFFERENT user_id values, never a value
    leaked from the other in-flight call.

    A `threading.Barrier(2)` inside the mock handler forces both requests to
    be genuinely in-flight at the same time (both must arrive before either
    is allowed to return) -- if `user_id` were ever stored on `self` instead
    of threaded as a pure per-call argument, this is exactly the interleaving
    that would expose it: thread B's `self._user_id = "user-b"` assignment
    would race ahead of thread A's own request being built/sent, and thread
    A's request could go out carrying thread B's identity instead of its
    own."""
    barrier = threading.Barrier(2)
    captured_by_marker: dict[str, str | None] = {}
    lock = threading.Lock()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        # The node_id doubles as this call's own marker -- lets the
        # assertions below tie a captured header back to the specific call
        # that produced it, regardless of which thread's request the mock
        # transport happens to process first.
        marker = next(iter(json.loads(block_text(body["messages"][1]["content"]))))
        # Both requests must be fully built and in-flight before either is
        # allowed to complete -- forces genuine concurrent overlap instead of
        # accidentally-serialized execution that would never exercise the
        # hazard this test exists to catch.
        barrier.wait(timeout=5)
        with lock:
            captured_by_marker[marker] = request.headers.get("x-req2ado-user-id")
        return httpx.Response(200, json={"content": json.dumps({})})

    # ONE shared client instance -- same module-level-singleton shape as
    # main.py's _dedup_judge_client/_checklist_client.
    shared_client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    shared_client._transport = httpx.MockTransport(handler)

    def call_as(user_id: str) -> None:
        shared_client.score_requirements_for_document(
            {user_id: "requirement text"},
            user_id=user_id,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        future_a = executor.submit(call_as, "user-a")
        future_b = executor.submit(call_as, "user-b")
        future_a.result(timeout=5)
        future_b.result(timeout=5)

    assert captured_by_marker == {"user-a": "user-a", "user-b": "user-b"}


def test_describe_figure_sends_the_x_req2ado_user_id_header_when_supplied() -> None:
    # Vision client: same per-call, never-on-self contract as
    # OrchestratorLlmClient -- see this test module's own header block
    # comment.
    from app.vision.orchestrator_vision_client import OrchestratorVisionClient

    captured_headers: dict[str, str | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/llm/vision"
        captured_headers["value"] = request.headers.get("x-req2ado-user-id")
        return httpx.Response(
            200, json={"description": json.dumps({"significant": False, "description": ""})}
        )

    client = OrchestratorVisionClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-image-bytes", user_id="user-789")

    assert captured_headers["value"] == "user-789"


def test_describe_figure_omits_the_x_req2ado_user_id_header_when_not_supplied() -> None:
    from app.vision.orchestrator_vision_client import OrchestratorVisionClient

    captured_headers: dict[str, bool] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_headers["present"] = "x-req2ado-user-id" in request.headers
        return httpx.Response(
            200, json={"description": json.dumps({"significant": False, "description": ""})}
        )

    client = OrchestratorVisionClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.describe_figure(b"fake-image-bytes")

    assert captured_headers["present"] is False


_KEYED_CALLS = [
    ("title_tags", lambda c: c.title_and_tags_for_rows({"r1": "x", "r2": "y"})),
    (
        "parent_summary",
        lambda c: c.summarize_parent_nodes(
            {"p1": {"title": "t", "requirement_titles": [], "requirement_descriptions": []}}
        ),
    ),
    ("synthesis", lambda c: c.synthesize_leaf_requirements({"s1": {"text": "x", "context": ""}})),
    (
        "score_requirements",
        lambda c: c.score_requirements_for_document({"0": "The unit shall survive a 1m drop."}),
    ),
    (
        "authoring",
        lambda c: c.author_content(
            "Section text.", {"n0": {"type": "Requirement", "title": "T", "parent_id": None}}
        ),
    ),
    (
        "kb_relevance",
        lambda c: c.judge_kb_relevance("outline", [{"source_file": "a.docx", "text": "x"}]),
    ),
]


def _captured_request_body(call, mode: str, monkeypatch) -> dict:
    monkeypatch.setattr(orchestrator_llm_client_module.settings, "keyed_schema_mode", mode)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)
    call(client)
    return captured["body"]


@pytest.mark.parametrize(("name", "call"), _KEYED_CALLS, ids=[n for n, _ in _KEYED_CALLS])
def test_keyed_calls_send_no_strict_schema_by_default(name, call, monkeypatch) -> None:
    # Prod: the open-map schema collapses to `{}` on claude-opus-4-8 (and is invalid strict
    # JSON Schema on OpenAI/Azure); per-call explicit keys blow the grammar-size limit. The
    # prompts state the shape, so keyed passes send no responseSchema.
    body = _captured_request_body(call, "none", monkeypatch)
    assert "responseSchema" not in body


@pytest.mark.parametrize(("name", "call"), _KEYED_CALLS, ids=[n for n, _ in _KEYED_CALLS])
def test_keyed_calls_still_send_the_legacy_schema_when_that_mode_is_selected(
    name, call, monkeypatch
) -> None:
    body = _captured_request_body(call, "legacy_map", monkeypatch)
    assert body["responseSchema"]["schema"]["additionalProperties"]  # the original open map


def test_the_keyed_schema_mode_defaults_to_none() -> None:
    from app.config import Settings

    assert Settings().keyed_schema_mode == "none"


def test_a_structured_call_that_ends_abnormally_logs_its_finish_reason_and_a_normal_stop_does_not(
    caplog,
) -> None:
    import logging

    def make(finish_reason: str) -> OrchestratorLlmClient:
        client = OrchestratorLlmClient(
            base_url="http://orchestrator.internal", bearer_token="test-bearer"
        )
        client._transport = _mock_transport({"content": "{}", "finishReason": finish_reason})
        return client

    with caplog.at_level(logging.WARNING, logger="app.survey.orchestrator_llm_client"):
        make("stop").title_and_tags_for_rows({"det0_h1": "x"})
        assert not [r for r in caplog.records if "finishReason" in r.getMessage()]
        make("length").title_and_tags_for_rows({"det0_h1": "x"})

    assert [r.getMessage() for r in caplog.records if "finishReason=length" in r.getMessage()]


def test_post_chat_does_not_resend_a_request_that_already_ran_long_before_failing(
    monkeypatch,
) -> None:
    # Prod job 0b9a134f: a scoring call hung ~300 s, the upstream gave up, and the identical
    # request was re-sent twice more (~15 minutes per batch). A retryable status that only
    # arrives after the call ran this long is returned to the caller, which can split the work.
    monkeypatch.setattr(orchestrator_llm_client_module.time, "sleep", lambda _seconds: None)
    clock = iter([0.0, orchestrator_llm_client_module._SLOW_FAILURE_SECONDS + 1.0])
    monkeypatch.setattr(orchestrator_llm_client_module.time, "monotonic", lambda: next(clock))
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, json={"message": "empty completion"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    response = client._post_chat(_CALL, {}, None)

    assert response.status_code == 500
    assert calls["n"] == 1


def test_post_chat_still_retries_a_fast_5xx_with_backoff(monkeypatch) -> None:
    sleeps: list[float] = []
    monkeypatch.setattr(
        orchestrator_llm_client_module.time, "sleep", lambda seconds: sleeps.append(seconds)
    )
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return (
            httpx.Response(503) if calls["n"] < 3 else httpx.Response(200, json={"content": "{}"})
        )

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    response = client._post_chat(_CALL, {}, None)

    assert response.status_code == 200
    assert calls["n"] == 3
    assert sleeps == [2.0, 8.0]


def test_a_chat_call_in_flight_stops_at_once_when_the_run_is_cancelled() -> None:
    """A cancelled run must not wait out a window already sent: the call closes its connection, so the orchestrator sees the caller go
    and stops the upstream request (real socket, not a mock transport: a mock handler cannot be interrupted)."""
    import http.server
    import time

    from app.job_cancel import JobCancelled, cancellation_scope

    release = threading.Event()
    received = threading.Event()

    class Slow(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            received.set()
            release.wait(10)  # the "model" is still thinking

        def log_message(self, *_args) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = OrchestratorLlmClient(
            base_url=f"http://127.0.0.1:{server.server_port}", bearer_token="test-bearer"
        )
        outcome: dict = {}
        with cancellation_scope() as token:

            def call() -> None:
                started = time.monotonic()
                try:
                    client._post_chat(_CALL, {}, None)
                except BaseException as exc:  # noqa: BLE001
                    outcome["error"] = exc
                outcome["seconds"] = time.monotonic() - started

            import contextvars

            # the pool workers of a run start under a copy of its context (submit_in_context); a bare Thread would not see the token
            worker = threading.Thread(target=contextvars.copy_context().run, args=(call,))
            worker.start()
            assert received.wait(5)
            token.cancel()
            worker.join(5)
        assert not worker.is_alive()
        assert isinstance(outcome["error"], JobCancelled)
        assert outcome["seconds"] < 3
        assert token._callbacks == []  # the call took its hook off again
    finally:
        release.set()
        server.shutdown()


def test_a_chat_call_leaves_no_cancel_hook_behind_when_it_finishes() -> None:
    from app.job_cancel import cancellation_scope

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "{}"})
    with cancellation_scope() as token:
        client._post_chat(_CALL, {}, None)
        assert token._callbacks == []


def test_a_study_call_is_not_re_sent_after_a_504_because_the_study_treats_it_as_overload(
    monkeypatch,
) -> None:
    monkeypatch.setattr(orchestrator_llm_client_module.time, "sleep", lambda _seconds: None)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(504, json={"message": "Upstream did not answer in time"})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    assert client._post_chat(_CALL, {"budgetKind": "study"}, None).status_code == 504
    assert calls["n"] == 1
    calls["n"] = 0
    assert (
        client._post_chat(_CALL, {}, None).status_code == 504
    )  # any other call still gets its retries
    assert calls["n"] == orchestrator_llm_client_module._MAX_CHAT_RETRY_ATTEMPTS


def test_name_root_groups_folds_the_names_array_and_ignores_malformed_entries() -> None:
    answer = {
        "names": [
            {"group_id": "g0", "title": " Bus   Interfaces "},
            {"group_id": "g1", "title": ""},
            "junk",
            {"title": "x"},
        ]
    }
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps(answer)})
    assert client.name_root_groups({"g0": ["I2C", "UART"], "g1": ["a", "b"]}) == {
        "g0": "Bus Interfaces"
    }
    client._transport = _mock_transport({"content": json.dumps({"names": "nope"})})
    assert client.name_root_groups({"g0": ["a", "b"]}) == {}


def test_the_group_naming_schema_follows_the_strict_vendor_rules() -> None:
    from app.survey._response_schemas import root_group_names_schema

    assert _strict_violations(root_group_names_schema()["schema"]) == []


def test_judge_kb_document_relevance_sends_the_name_and_excerpt_and_reads_the_verdict() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"content": json.dumps({"relevant": False, "reason": "A recipe."})}
        )

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)
    verdict = client.judge_kb_document_relevance("recipe.pdf", "Mix flour and water.")

    assert verdict == {"relevant": False, "reason": "A recipe."}
    user = json.loads(block_text(captured["body"]["messages"][1]["content"]))
    assert user == {"file_name": "recipe.pdf", "excerpt": "Mix flour and water."}
    assert captured["body"]["responseSchema"]["name"] == "kb_document_relevance"


def test_judge_kb_document_relevance_rejects_a_malformed_answer() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps({"relevant": "maybe"})})
    with pytest.raises(ValueError):
        client.judge_kb_document_relevance("a.pdf", "text")


def test_extract_kb_document_profile_keeps_only_well_formed_entries() -> None:
    answer = {
        "categories": [
            {"name": "Testable", "pass_condition": "Can be verified"},
            {"name": "", "pass_condition": "x"},
            "junk",
        ],
        "type_definitions": [
            {"item_type": "requirement", "text": "A statement of need"},
            {"item_type": "story", "text": "no"},
        ],
        "rules": ["One requirement per statement", "", 7],
        "glossary": [
            {"term": "SRS", "definition": "software requirements specification"},
            {"term": "", "definition": "x"},
        ],
    }
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps(answer)})
    result = client.extract_kb_document_profile("HowTo.pptx", "window text")

    assert result["categories"] == [{"name": "Testable", "pass_condition": "Can be verified"}]
    assert result["type_definitions"] == [
        {"item_type": "requirement", "text": "A statement of need"}
    ]
    assert result["rules"] == ["One requirement per statement"]
    assert result["glossary"] == [
        {"term": "SRS", "definition": "software requirements specification"}
    ]


def test_extract_kb_document_profile_accepts_nothing_found_and_raises_on_a_non_object() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport(
        {
            "content": json.dumps(
                {"categories": [], "type_definitions": [], "rules": [], "glossary": []}
            )
        }
    )
    assert client.extract_kb_document_profile("a.pptx", "t") == {
        "categories": [],
        "type_definitions": [],
        "rules": [],
        "glossary": [],
        "obligation_forms": [],
    }
    client._transport = _mock_transport({"content": json.dumps(["x"])})
    with pytest.raises(ValueError):
        client.extract_kb_document_profile("a.pptx", "t")


def _system_prompts(call, users: list[str] | None = None) -> list[str]:
    prompts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        prompts.append(body["messages"][0]["content"])
        if users is not None:
            users.append(body["messages"][1]["content"])
        return httpx.Response(200, json={"content": json.dumps({"rows": []})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)
    call(client)
    return prompts


_WRITING_CALLS = {
    "title_and_tags_for_rows": lambda c: c.title_and_tags_for_rows(
        {"r1": "The receiver shall lock."}
    ),
    "summarize_parent_nodes": lambda c: c.summarize_parent_nodes(
        {"p1": {"title": "T", "type": "Feature", "children": ["The receiver shall lock."]}}
    ),
    "synthesize_leaf_requirements": lambda c: c.synthesize_leaf_requirements(
        {"s1": {"label": "Size: 3U", "context": ""}}
    ),
}


@pytest.mark.parametrize("name", sorted(_WRITING_CALLS))
def test_the_authoring_standard_reaches_every_item_writing_prompt_once_as_data_and_changes_nothing_without_it(
    name: str,
) -> None:
    plain_users: list[str] = []
    plain = _system_prompts(_WRITING_CALLS[name], plain_users)
    assert plain and all("authoring standard" not in p for p in plain)
    assert all("<org_standard>" not in u for u in plain_users)

    def with_standard(client: OrchestratorLlmClient) -> None:
        client.authoring_standard = "Requirement: A verifiable statement of need"
        _WRITING_CALLS[name](client)

    users: list[str] = []
    standard = _system_prompts(with_standard, users)
    assert standard and all(
        block_text(u, "org_standard") == "Requirement: A verifiable statement of need"
        for u in users
    )
    assert all("A verifiable statement of need" not in p for p in standard)  # never an instruction
    # The instructions after the guard are the original prompt, intact.
    assert all(p.split("\n\n", 1)[1] == plain[0].split("\n\n", 1)[1] for p in standard)


def test_judge_rule_conformance_returns_verdicts_for_the_given_items_only() -> None:
    answer = {
        "verdicts": [
            {"id": "n1", "conforms": True},
            {"id": "n2", "conforms": False},
            {"id": "ghost", "conforms": True},
            {"id": "n3", "conforms": "yes"},
        ]
    }
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps(answer)})
    # A boolean answer (prompt v1's shape) reads as conforms / violates.
    assert client.judge_rule_conformance(
        "One shall per sentence", {"n1": "a", "n2": "b", "n3": "c"}
    ) == {"n1": "conforms", "n2": "violates"}
    v2 = {
        "verdicts": [
            {"id": "n1", "verdict": "not_applicable"},
            {"id": "n2", "verdict": "violates"},
            {"id": "n3", "verdict": "maybe"},
        ]
    }
    client._transport = _mock_transport({"content": json.dumps(v2)})
    assert client.judge_rule_conformance("r", {"n1": "a", "n2": "b", "n3": "c"}) == {
        "n1": "not_applicable",
        "n2": "violates",
    }
    client._transport = _mock_transport({"content": json.dumps({"verdicts": "no"})})
    with pytest.raises(ValueError):
        client.judge_rule_conformance("r", {"n1": "a"})


def test_consolidate_kb_categories_sends_the_categories_and_keeps_only_well_formed_groups() -> None:
    captured: dict = {}
    answer = {
        "categories": [
            {
                "name": "Testable",
                "pass_condition": "Can be verified",
                "merged_from": ["Testable", "Testability"],
            },
            {"name": "", "pass_condition": "x", "merged_from": ["Y"]},
            {"name": "NoMembers", "pass_condition": "x", "merged_from": []},
            "junk",
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps(answer)})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)
    groups = client.consolidate_kb_categories(
        [
            {"name": "Testable", "pass_condition": "a"},
            {"name": "Testability", "pass_condition": "b"},
        ],
        8,
    )

    assert groups == [
        {
            "name": "Testable",
            "pass_condition": "Can be verified",
            "merged_from": ["Testable", "Testability"],
        }
    ]
    user = json.loads(block_text(captured["body"]["messages"][1]["content"]))
    assert user["max_categories"] == 8 and [c["name"] for c in user["categories"]] == [
        "Testable",
        "Testability",
    ]
    assert captured["body"]["responseSchema"]["name"] == "kb_category_consolidation"


def test_consolidate_kb_categories_rejects_a_malformed_answer() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": json.dumps({"nope": 1})})
    with pytest.raises(ValueError):
        client.consolidate_kb_categories([{"name": "A", "pass_condition": "a"}], 8)


def test_consolidate_kb_categories_offers_the_previous_names_only_when_there_are_some() -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"content": json.dumps({"categories": []})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)
    client.consolidate_kb_categories([{"name": "A", "pass_condition": "a"}], 16)
    client.consolidate_kb_categories(
        [{"name": "A", "pass_condition": "a"}], 16, preferred_names=["Testable"]
    )
    first, second = (json.loads(block_text(b["messages"][1]["content"])) for b in bodies)
    assert "preferred_names" not in first and second["preferred_names"] == ["Testable"]


# study_document_window / propose_acceptance_criteria (P9) ----


class _DictCache:
    def __init__(self) -> None:
        self.store: dict = {}

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value) -> None:
        self.store[key] = value


def test_study_document_window_returns_the_object_and_sends_the_window_text() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["user"] = json.loads(block_text(body["messages"][1]["content"]))
        return httpx.Response(200, json={"content": '{"placeholder_tokens": ["TBD"]}'})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    assert client.study_document_window("Latency TBD ms") == {"placeholder_tokens": ["TBD"]}
    assert captured["user"] == {"text": "Latency TBD ms"}


def test_study_document_window_rejects_a_non_object_answer() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": "[1, 2]"})

    with pytest.raises(ValueError):
        client.study_document_window("text")


def test_client_study_window_is_no_longer_cached() -> None:
    # The per-user study store (app.leveling.study_store) replaced the client-side copy, which a cancelled run could not delete.
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"content": '{"glossary": []}'})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=_DictCache()
    )
    client._transport = httpx.MockTransport(handler)

    client.study_document_window("same window")
    client.study_document_window("same window")
    client.study_document_window("another window")

    assert calls["n"] == 3
    assert client._cache.store == {}


def test_propose_acceptance_criteria_keeps_only_asked_ids_and_drops_the_contract_comment() -> None:
    captured: dict = {}
    answer = {
        "items": [
            {"id": "a", "criteria": ["c1"], "assumptions": [], "needs_author_input": False},
            {"id": "ghost", "criteria": ["x"], "assumptions": [], "needs_author_input": False},
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["system"] = body["messages"][0]["content"]
        captured["user"] = json.loads(block_text(body["messages"][1]["content"]))
        return httpx.Response(200, json={"content": json.dumps(answer)})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    result = client.propose_acceptance_criteria({"a": {"text": "The unit shall x."}})

    assert list(result) == ["a"]
    assert result["a"]["criteria"] == ["c1"]
    assert captured["user"] == {"a": {"text": "The unit shall x."}}
    assert not any(line.startswith("#") for line in captured["system"].splitlines())
    assert "NEVER invent" in captured["system"]


def test_propose_acceptance_criteria_rejects_an_answer_without_items() -> None:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = _mock_transport({"content": '{"nope": 1}'})

    with pytest.raises(ValueError):
        client.propose_acceptance_criteria({"a": {"text": "t"}})


def test_propose_acceptance_criteria_caches_only_a_complete_answer() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        items = [{"id": "a", "criteria": ["c"], "assumptions": [], "needs_author_input": False}]
        return httpx.Response(200, json={"content": json.dumps({"items": items})})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=_DictCache()
    )
    client._transport = httpx.MockTransport(handler)

    client.propose_acceptance_criteria({"a": {"text": "t"}}, user_id="user-a")
    client.propose_acceptance_criteria(
        {"a": {"text": "t"}}, user_id="user-a"
    )  # complete: served from the cache
    client.propose_acceptance_criteria(
        {"a": {"text": "t"}, "b": {"text": "u"}}, user_id="user-a"
    )  # b missing: not cached
    client.propose_acceptance_criteria({"a": {"text": "t"}, "b": {"text": "u"}}, user_id="user-a")

    assert calls["n"] == 3


# per-user cache scope for propose_acceptance_criteria ----


def _scoped_cache_client(calls: dict, cache: "_DictCache | None" = None) -> OrchestratorLlmClient:
    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        content = {
            "glossary": [],
            "items": [
                {"id": "a", "criteria": ["c"], "assumptions": [], "needs_author_input": False}
            ],
        }
        return httpx.Response(200, json={"content": json.dumps(content)})

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal",
        bearer_token="test-bearer",
        cache=cache if cache is not None else _DictCache(),
    )
    client._transport = httpx.MockTransport(handler)
    return client


def test_propose_acceptance_criteria_cache_is_not_shared_between_users() -> None:
    calls = {"n": 0}
    client = _scoped_cache_client(calls)

    client.propose_acceptance_criteria({"a": {"text": "t"}}, user_id="user-a")
    client.propose_acceptance_criteria({"a": {"text": "t"}}, user_id="user-b")

    assert calls["n"] == 2


def test_propose_acceptance_criteria_cache_hits_for_the_same_user() -> None:
    calls = {"n": 0}
    client = _scoped_cache_client(calls)

    client.propose_acceptance_criteria({"a": {"text": "t"}}, user_id="user-a")
    client.propose_acceptance_criteria({"a": {"text": "t"}}, user_id="user-a")

    assert calls["n"] == 1


def test_cache_keys_never_contain_the_raw_user_id() -> None:
    user_id = "Microsoft.Identity;someone@example.com"
    cache = _DictCache()
    client = _scoped_cache_client({"n": 0}, cache)

    client.propose_acceptance_criteria({"a": {"text": "t"}}, user_id=user_id)

    assert len(cache.store) == 1
    pieces = {user_id[i : i + 7] for i in range(len(user_id) - 6)}
    for key in cache.store:
        assert not any(piece in str(key) for piece in pieces)


def test_a_call_without_a_user_id_never_reads_or_writes_the_cache() -> None:
    calls = {"n": 0}

    class _SpyCache:
        def __init__(self) -> None:
            self.gets = self.sets = 0

        def get(self, key):
            self.gets += 1

        def set(self, key, value):
            self.sets += 1

    cache = _SpyCache()
    client = _scoped_cache_client(calls, cache)

    client.propose_acceptance_criteria({"a": {"text": "t"}}, user_id=None)
    client.propose_acceptance_criteria({"a": {"text": "t"}})

    assert calls["n"] == 2 and (cache.gets, cache.sets) == (0, 0)


# background (the job's context primer) and the per-attempt gate for propose_acceptance_criteria ----


def test_propose_acceptance_criteria_sends_the_background_as_a_block_only_when_given() -> None:
    systems: list[str] = []
    users: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        messages = json.loads(request.content)["messages"]
        systems.append(messages[0]["content"])
        users.append(messages[1]["content"])
        return httpx.Response(
            200,
            json={
                "content": json.dumps(
                    {
                        "items": [
                            {
                                "id": "a",
                                "criteria": [],
                                "assumptions": [],
                                "needs_author_input": False,
                            }
                        ]
                    }
                )
            },
        )

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    client.propose_acceptance_criteria({"a": {"text": "t"}})
    client.propose_acceptance_criteria({"a": {"text": "t"}}, background="A radar ICD.")

    assert "<background>" not in systems[0] and block_text(users[0], "background") is None
    assert block_text(users[1], "background") == "A radar ICD."
    assert "A radar ICD." not in systems[1] and "never a source of numbers" in systems[1]


def test_propose_acceptance_criteria_cache_key_follows_the_background() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200,
            json={
                "content": json.dumps(
                    {
                        "items": [
                            {
                                "id": "a",
                                "criteria": [],
                                "assumptions": [],
                                "needs_author_input": False,
                            }
                        ]
                    }
                )
            },
        )

    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=_DictCache()
    )
    client._transport = httpx.MockTransport(handler)

    for background in (None, "one", "one", "two"):
        client.propose_acceptance_criteria(
            {"a": {"text": "t"}}, user_id="user-a", background=background
        )

    assert calls["n"] == 3


def test_the_call_gate_wraps_each_attempt_but_not_the_retry_back_off(monkeypatch) -> None:
    from app.leveling.llm_call_gate import use_gate

    events: list[str] = []
    answers = iter([429, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        events.append("call")
        status = next(answers)
        return httpx.Response(status, json={"content": json.dumps({"items": []})})

    @contextlib.contextmanager
    def gate():
        events.append("enter")
        try:
            yield
        finally:
            events.append("exit")

    monkeypatch.setattr(
        "app.survey.orchestrator_llm_client.time.sleep", lambda seconds: events.append("sleep")
    )
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)

    with use_gate(gate):
        client.propose_acceptance_criteria({"a": {"text": "t"}})

    assert events == ["enter", "call", "exit", "sleep", "enter", "call", "exit"]


_STUDY_ANSWER = {
    "glossary": [],
    "placeholder_tokens": [],
    "verification_statements": [],
    "standards_cited": [],
    "table_roles": [],
}


def _study_client(handler) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer"
    )
    client._transport = httpx.MockTransport(handler)
    return client


def test_a_study_window_call_asks_for_the_study_ladder_with_a_deadline() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"content": json.dumps(_STUDY_ANSWER), "finishReason": "stop"}
        )

    _study_client(handler).study_document_window("some text")

    assert captured["body"]["budgetKind"] == "study"
    assert captured["body"]["maxTokens"] == 3000
    assert captured["body"]["deadlineMs"] == 600_000
    assert "reasoning_effort" not in captured["body"]


def test_an_empty_answer_cut_off_at_the_limit_is_a_typed_empty_cutoff() -> None:
    from app.leveling.document_study import StudyLengthCutoff

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": "", "finishReason": "length"})

    with pytest.raises(StudyLengthCutoff) as caught:
        _study_client(handler).study_document_window("some text")
    assert caught.value.empty is True


def test_a_partial_answer_cut_off_at_the_limit_is_a_typed_partial_cutoff_not_a_studied_window() -> (
    None
):
    from app.leveling.document_study import StudyLengthCutoff

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "content": '{"glossary": [], "placeholder_tokens": ["TB',
                "finishReason": "length",
            },
        )

    with pytest.raises(StudyLengthCutoff) as caught:
        _study_client(handler).study_document_window("some text")
    assert caught.value.empty is False


def test_an_ordinary_chat_json_call_sends_no_budget_fields_and_still_ignores_a_length_ending() -> (
    None
):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "content": json.dumps({"n0": {"score": 85, "issues": []}}),
                "finishReason": "length",
            },
        )

    client = _study_client(handler)
    client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})

    assert "budgetKind" not in captured["body"] and "deadlineMs" not in captured["body"]


def _capture_headers(captured: list[dict]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(dict(request.headers))
        return httpx.Response(200, json={"content": json.dumps({"n0": {"score": 85, "issues": []}})})

    return httpx.MockTransport(handler)


def test_chat_call_inside_a_job_names_the_job_and_stage_for_the_token_ledger() -> None:
    from app.logging_context import job_id_scope

    captured: list[dict] = []
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _capture_headers(captured)

    with job_id_scope("job-42"):
        client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})

    assert captured[0]["x-req2ado-job-id"] == "job-42"
    assert captured[0]["x-req2ado-stage"] == "score_requirements_for_document"


def test_chat_call_outside_a_job_sends_no_ledger_headers() -> None:
    captured: list[dict] = []
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _capture_headers(captured)

    client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})

    assert "x-req2ado-job-id" not in captured[0]
    assert "x-req2ado-stage" not in captured[0]


def _rate_limited_run(monkeypatch, body: dict):
    sleeps: list[float] = []
    monkeypatch.setattr(orchestrator_llm_client_module.time, "sleep", lambda seconds: sleeps.append(seconds))
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, json=body)

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)
    with pytest.raises(httpx.HTTPStatusError) as raised:
        client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})
    return raised.value.response.status_code, calls["n"], sleeps


def test_post_chat_does_not_resend_a_429_the_orchestrator_already_waited_out_and_repeated(monkeypatch) -> None:
    # The orchestrator waits out Retry-After and repeats a rate-limited call itself, and marks the 429 it still got afterwards.
    # Resending that one here multiplied each rate-limited call (and spent a token quota faster).
    status, calls, sleeps = _rate_limited_run(
        monkeypatch, {"message": "RATE_LIMIT_RETRIED: 429 slow down"}
    )
    assert status == 429
    assert calls == 1
    assert sleeps == []


def test_post_chat_still_retries_a_429_the_orchestrator_gave_up_on_early(monkeypatch) -> None:
    # No mark: the orchestrator had no time or attempts left and did not repeat the call, so a retry here is the only one it gets.
    status, calls, sleeps = _rate_limited_run(monkeypatch, {"message": "429 slow down"})
    assert status == 429
    assert calls == 3
    assert sleeps == [2.0, 8.0]


def _budget_transport(calls: dict) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            402,
            json={"statusCode": 402, "message": "LLM_BUDGET_EXCEEDED: 400 Budget has been exceeded!"},
        )

    return httpx.MockTransport(handler)


def test_a_used_up_budget_stops_the_run_at_the_first_refusal(monkeypatch) -> None:
    from app import job_cancel

    sleeps: list[float] = []
    monkeypatch.setattr(orchestrator_llm_client_module.time, "sleep", lambda s: sleeps.append(s))
    calls = {"n": 0}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _budget_transport(calls)

    with job_cancel.cancellation_scope() as token:
        with pytest.raises(job_cancel.LlmBudgetExceeded, match="Budget has been exceeded"):
            client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})
        # Every later call of the run is refused before it is sent: no more of the spent budget is used.
        with pytest.raises(job_cancel.LlmBudgetExceeded):
            client.score_requirements_for_document({"n0": "Another requirement."})
        assert token.cancelled and token.reason == job_cancel.BUDGET_REASON

    assert calls["n"] == 1
    assert sleeps == []


def test_a_used_up_budget_outside_a_run_is_returned_as_the_402_it_is() -> None:
    calls = {"n": 0}
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = _budget_transport(calls)

    with pytest.raises(httpx.HTTPStatusError) as raised:
        client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})

    assert raised.value.response.status_code == 402
    assert calls["n"] == 1


def test_a_402_that_is_not_a_budget_refusal_does_not_stop_the_run() -> None:
    from app import job_cancel

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(lambda request: httpx.Response(402, json={"message": "payment required"}))

    with job_cancel.cancellation_scope() as token:
        with pytest.raises(httpx.HTTPStatusError):
            client.score_requirements_for_document({"n0": "The unit shall power on within 2 seconds."})
        assert not token.cancelled


def _study_answer() -> dict:
    return {
        "kind": "requirements_list",
        "summary": "A requirements list.",
        "header_rows": 1,
        "id_column": 0,
        "title_column": 2,
        "text_columns": [3],
        "group_columns": [1],
    }


def test_study_spreadsheet_sends_the_sample_and_returns_the_models_answer() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"content": json.dumps(_study_answer())})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    answer = client.study_spreadsheet({"sheet": "Reqs", "rowCount": 2001}, user_id="u1")

    assert answer == _study_answer()
    body = seen[0]
    assert json.loads(block_text(body["messages"][1]["content"])) == {
        "sheet": "Reqs",
        "rowCount": 2001,
    }
    assert body["responseSchema"]["name"] == "sheet_study"
    assert set(body["responseSchema"]["schema"]["required"]) == set(_study_answer())


def test_study_spreadsheet_refuses_an_answer_that_is_not_an_object() -> None:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"content": json.dumps([1, 2])}))

    with pytest.raises(ValueError, match="malformed JSON"):
        client.study_spreadsheet({"sheet": "Reqs"}, user_id="u1")


def test_study_spreadsheet_reads_an_identical_sheet_once() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"content": json.dumps(_study_answer())})

    class Cache(dict):
        def get(self, key):
            return super().get(key)

        def set(self, key, value):
            self[key] = value

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=Cache())
    client._transport = httpx.MockTransport(handler)

    first = client.study_spreadsheet({"sheet": "Reqs"}, user_id="u1")
    second = client.study_spreadsheet({"sheet": "Reqs"}, user_id="u1")

    assert first == second and calls["n"] == 1
