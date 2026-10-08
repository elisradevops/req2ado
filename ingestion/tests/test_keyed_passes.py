"""The remaining keyed passes on the keyed-result module (synthesis, parent summary, KB relevance,
content authoring, figure/table mapping): same contract as title/tag (tests/test_keyed_calls.py)
-- one generated prompt sentence and schema, array wire format, tolerant reading -- with the
per-pass details that differ: bare-verdict entries (KB), nullable ids (mapping), no retry for the two
passes whose callers already decide what an absent id means."""
import json

import httpx
import pytest

import app.survey.keyed_calls as keyed_calls_module
from app.prompts import load_prompt
from app.survey.keyed_calls import describe_output, items_schema, mode_for, reset_degraded, wrap_scalar_entries
from app.survey.keyed_specs import (
    AUTHOR_CONTENT_SPEC,
    FIGURE_TABLE_MAPPING_SPEC,
    KB_RELEVANCE_SPEC,
    PARENT_SUMMARY_SPEC,
    SYNTHESIS_SPEC,
    TITLE_TAGS_SPEC,
)
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import RequirementTag

_TAGS = ", ".join(t.value for t in RequirementTag)

# spec -> (prompt name, the markers the ORIGINAL (v1) prompt took, the markers the v2 prompt takes besides output_format)
PASSES = {
    "synthesis": (SYNTHESIS_SPEC, "synthesize_leaf_requirements", {"tag_vocabulary": _TAGS, "row_count": "3"}, {"row_count": "3"}),
    "parent_summary": (PARENT_SUMMARY_SPEC, "summarize_parent_nodes", {"node_count": "3"}, {"node_count": "3"}),
    "kb_relevance": (KB_RELEVANCE_SPEC, "judge_kb_relevance", {}, {}),
    "author_content": (
        AUTHOR_CONTENT_SPEC, "author_content", {"tag_vocabulary": _TAGS, "node_count": "3"},
        {"tag_vocabulary": _TAGS, "node_count": "3"},
    ),
    "figure_table_mapping": (FIGURE_TABLE_MAPPING_SPEC, "map_figures_tables", {"item_count": "3"}, {"item_count": "3"}),
}


@pytest.fixture(autouse=True)
def _default_modes(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_mode", "none")
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "")
    reset_degraded()
    yield
    reset_degraded()


@pytest.fixture
def all_array(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", ",".join(PASSES))


def _client(handler) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)
    return client


def _user_ids(body: dict, key: str | None = None) -> list[str]:
    content = json.loads(body["messages"][-1]["content"])
    return list(content[key] if key else content)


# -- contracts ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", PASSES)
def test_the_default_mode_renders_exactly_the_prompt_prod_already_ran(name) -> None:
    spec, prompt, v1_markers, v2_markers = PASSES[name]
    v1 = load_prompt(prompt, version=1, **v1_markers)
    for mode in ("none", "legacy_map"):
        assert load_prompt(prompt, version=2, output_format=describe_output(spec, mode), **v2_markers) == v1


@pytest.mark.parametrize("name", PASSES)
def test_the_output_sentence_names_every_field_of_the_schema(name) -> None:
    spec = PASSES[name][0]
    sentence = describe_output(spec, "array")
    for field in spec.fields:
        assert spec.field_prompts[field] in sentence
    entry = items_schema(spec)["schema"]["properties"]["items"]["items"]
    assert set(entry["properties"]) == {"id", *spec.fields}
    assert entry["required"] == list(entry["properties"]) and entry["additionalProperties"] is False


def _walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


@pytest.mark.parametrize("name", PASSES)
def test_the_array_schemas_follow_the_vendor_rules_for_strict_structured_output(name) -> None:
    schema = items_schema(PASSES[name][0])
    assert schema["strict"] is True
    for node in _walk(schema["schema"]):
        assert "minimum" not in node and "maximum" not in node and "minItems" not in node
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert set(node["required"]) == set(node["properties"])
        assert not isinstance(node.get("type"), list)  # unions are written as anyOf


def test_a_three_field_sentence_reads_as_a_list_and_a_two_field_one_is_unchanged() -> None:
    assert "'text' (the synthesized requirement statement), and 'tags'" in describe_output(SYNTHESIS_SPEC, "none")
    assert "'title' (string) and 'description' (string)" in describe_output(PARENT_SUMMARY_SPEC, "none")
    assert "'title' (string) and 'tags'" in describe_output(TITLE_TAGS_SPEC, "none")


def test_modes_follow_the_named_passes(monkeypatch) -> None:
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "synthesis, kb_relevance")
    assert mode_for(SYNTHESIS_SPEC) == "array" and mode_for(KB_RELEVANCE_SPEC) == "array"
    assert mode_for(PARENT_SUMMARY_SPEC) == "none" and mode_for(AUTHOR_CONTENT_SPEC) == "none"


def test_scalar_entries_are_wrapped_and_other_shapes_left_alone() -> None:
    assert wrap_scalar_entries({"0": "relevant", "1": "not_relevant"}, "verdict") == {
        "0": {"verdict": "relevant"}, "1": {"verdict": "not_relevant"},
    }
    assert wrap_scalar_entries({"answer": {"0": "relevant"}}, "verdict") == {"answer": {"0": {"verdict": "relevant"}}}
    array = {"items": [{"id": "0", "verdict": "relevant"}]}
    assert wrap_scalar_entries(array, "verdict") == array
    assert wrap_scalar_entries([], "verdict") == [] and wrap_scalar_entries({}, "verdict") == {}


# -- synthesis and parent summary ----------------------------------------------------------

ROWS = {"r1": {"text": "Size: 3U", "context": "Chassis"}, "r2": {"text": "Over-current", "context": "Power"}}


def test_synthesis_in_array_mode_sends_the_fixed_schema_and_returns_an_id_map(all_array) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        items = [{"id": key, "title": f"T {key}", "text": f"The unit shall {key}.", "tags": ["safety"]} for key in _user_ids(body)]
        return httpx.Response(200, json={"content": json.dumps({"items": items})})

    result = _client(handler).synthesize_leaf_requirements(ROWS)

    assert result == {k: {"title": f"T {k}", "text": f"The unit shall {k}.", "tags": ["safety"]} for k in ROWS}
    assert len(seen) == 1 and seen[0]["responseSchema"] == items_schema(SYNTHESIS_SPEC)
    assert describe_output(SYNTHESIS_SPEC, "array") in seen[0]["messages"][0]["content"]


def test_synthesis_in_none_mode_sends_no_schema_and_reads_a_legacy_map() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert "responseSchema" not in body
        assert describe_output(SYNTHESIS_SPEC, "none") in body["messages"][0]["content"]
        return httpx.Response(200, json={"content": json.dumps({k: {"title": "T", "text": "X shall Y.", "tags": []} for k in ROWS})})

    assert set(_client(handler).synthesize_leaf_requirements(ROWS)) == set(ROWS)


def test_synthesis_retries_only_the_ids_the_answer_left_out(all_array) -> None:
    asked: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ids = _user_ids(json.loads(request.content))
        asked.append(ids)
        answered = ids[:1] if len(asked) == 1 else ids
        items = [{"id": key, "title": "T", "text": "X shall Y.", "tags": []} for key in answered]
        return httpx.Response(200, json={"content": json.dumps({"items": items})})

    result = _client(handler).synthesize_leaf_requirements(ROWS)

    assert set(result) == set(ROWS) and asked == [["r1", "r2"], ["r2"]]


NODES = {
    "p1": {"title": "Power", "requirement_titles": ["Overcurrent shutdown"], "requirement_descriptions": ["Shall shut down."]},
    "p2": {"title": "Chassis", "requirement_titles": ["Size"], "requirement_descriptions": ["Shall be 3U."]},
}


def test_parent_summary_in_array_mode_sends_the_fixed_schema_and_returns_an_id_map(all_array) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        items = [{"id": key, "title": f"Capability {key}", "description": f"Summary {key}."} for key in _user_ids(body)]
        return httpx.Response(200, json={"content": json.dumps({"items": items})})

    result = _client(handler).summarize_parent_nodes(NODES)

    assert result == {k: {"title": f"Capability {k}", "description": f"Summary {k}."} for k in NODES}
    assert seen[0]["responseSchema"] == items_schema(PARENT_SUMMARY_SPEC)


def test_parent_summary_in_none_mode_still_reads_a_legacy_map() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "responseSchema" not in json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({k: {"title": "T", "description": "D."} for k in NODES})})

    assert set(_client(handler).summarize_parent_nodes(NODES)) == set(NODES)


# -- KB relevance --------------------------------------------------------------------------

SNIPPETS = [{"source_file": "a.md", "text": "Alpha"}, {"source_file": "b.md", "text": "Beta"}, {"source_file": "c.md", "text": "Gamma"}]


def test_kb_relevance_returns_the_same_index_to_verdict_map_in_every_mode(monkeypatch) -> None:
    def handler_for(array: bool):
        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            ids = _user_ids(body, "snippets")
            verdicts = {i: ("relevant" if i == "1" else "not_relevant") for i in ids}
            payload = {"items": [{"id": i, "verdict": v} for i, v in verdicts.items()]} if array else verdicts
            assert ("responseSchema" in body) is array
            return httpx.Response(200, json={"content": json.dumps(payload)})
        return handler

    expected = {"0": "not_relevant", "1": "relevant", "2": "not_relevant"}
    assert _client(handler_for(False)).judge_kb_relevance("Section text", SNIPPETS) == expected
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "kb_relevance")
    assert _client(handler_for(True)).judge_kb_relevance("Section text", SNIPPETS) == expected


def test_kb_relevance_array_schema_constrains_the_verdict_to_the_two_values(monkeypatch) -> None:
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "kb_relevance")
    entry = items_schema(KB_RELEVANCE_SPEC)["schema"]["properties"]["items"]["items"]
    assert entry["properties"]["verdict"] == {"type": "string", "enum": ["relevant", "not_relevant"]}


def test_kb_relevance_asks_again_only_for_the_indices_it_was_not_given(monkeypatch) -> None:
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "kb_relevance")
    asked: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ids = _user_ids(json.loads(request.content), "snippets")
        asked.append(ids)
        answered = ids[:2] if len(asked) == 1 else ids
        return httpx.Response(200, json={"content": json.dumps({"items": [{"id": i, "verdict": "relevant"} for i in answered]})})

    result = _client(handler).judge_kb_relevance("Section text", SNIPPETS)

    assert result == {"0": "relevant", "1": "relevant", "2": "relevant"} and asked == [["0", "1", "2"], ["2"]]


# -- content authoring -----------------------------------------------------------------------

SKELETON = {
    "n0": {"type": "Feature", "title": "Display", "parent_id": None},
    "n1": {"type": "Requirement", "title": "HDR", "parent_id": "n0"},
    "n2": {"type": "Requirement", "title": "Contrast", "parent_id": "n0"},
}


def test_author_content_in_array_mode_returns_the_same_shape_as_before(all_array) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        items = [{"id": k, "description": f"D {k}", "tags": []} for k in json.loads(body["messages"][1]["content"])["nodes"]]
        return httpx.Response(200, json={"content": json.dumps({"items": items})})

    result, truncated = _client(handler).author_content("Section text", SKELETON)

    assert result == {k: {"description": f"D {k}", "tags": []} for k in SKELETON} and truncated is False
    assert seen[0]["responseSchema"] == items_schema(AUTHOR_CONTENT_SPEC)
    prompt = seen[0]["messages"][0]["content"]
    assert describe_output(AUTHOR_CONTENT_SPEC, "array") in prompt and "exactly 3 node(s)" in prompt


def test_author_content_never_repeats_a_call_for_omitted_nodes(all_array) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"content": json.dumps({"items": [{"id": "n1", "description": "D", "tags": []}]})})

    result, truncated = _client(handler).author_content("Section text", SKELETON)

    assert set(result) == {"n1"} and truncated is False and len(calls) == 1


def test_author_content_cut_off_by_the_token_limit_is_flagged_and_distrusts_its_last_node(all_array) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        items = [{"id": "n0", "description": "Complete.", "tags": []}, {"id": "n1", "description": "Cut of", "tags": []}]
        return httpx.Response(200, json={"content": json.dumps({"items": items}), "finishReason": "length"})

    result, truncated = _client(handler).author_content("Section text", SKELETON)

    assert truncated is True and set(result) == {"n0"}


def test_author_content_in_none_mode_keeps_the_old_wire_shape() -> None:
    content = {k: {"description": f"D {k}", "tags": []} for k in SKELETON}

    def handler(request: httpx.Request) -> httpx.Response:
        assert "responseSchema" not in json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps(content)})

    result, truncated = _client(handler).author_content("Section text", SKELETON)

    assert result == content and truncated is False


# -- figure / table mapping ---------------------------------------------------------------------

CANDIDATES = {"n1": {"type": "Requirement", "title": "Pinout"}}
ITEMS = {"f1": {"kind": "figure", "caption": "Pinout"}, "f2": {"kind": "figure", "caption": "Logo"}, "f3": {"kind": "table", "caption": "Elsewhere"}}


def test_mapping_keeps_the_three_outcomes_in_array_mode(all_array) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        items = [
            {"id": "f1", "node_id": "n1", "escalate": False},
            {"id": "f2", "node_id": None, "escalate": False},
            {"id": "f3", "node_id": None, "escalate": True},
        ]
        return httpx.Response(200, json={"content": json.dumps({"items": items})})

    result = _client(handler).map_figures_tables(CANDIDATES, ITEMS)

    assert result == {
        "f1": {"node_id": "n1", "escalate": False},
        "f2": {"node_id": None, "escalate": False},
        "f3": {"node_id": None, "escalate": True},
    }
    assert seen[0]["responseSchema"] == items_schema(FIGURE_TABLE_MAPPING_SPEC)
    node_id = items_schema(FIGURE_TABLE_MAPPING_SPEC)["schema"]["properties"]["items"]["items"]["properties"]["node_id"]
    assert node_id == {"anyOf": [{"type": "string"}, {"type": "null"}]}


def test_mapping_never_repeats_a_call_for_unanswered_items(all_array) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"content": json.dumps({"items": [{"id": "f1", "node_id": "n1", "escalate": False}]})})

    result = _client(handler).map_figures_tables(CANDIDATES, ITEMS)

    assert set(result) == {"f1"} and len(calls) == 1


def test_mapping_in_none_mode_keeps_the_old_wire_shape() -> None:
    content = {k: {"node_id": None, "escalate": True} for k in ITEMS}

    def handler(request: httpx.Request) -> httpx.Response:
        assert "responseSchema" not in json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps(content)})

    assert _client(handler).map_figures_tables(CANDIDATES, ITEMS) == content
