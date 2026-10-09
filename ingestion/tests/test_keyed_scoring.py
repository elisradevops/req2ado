"""Quality scoring on the keyed-result module: the array wire format (`categoryScores` as a list of
{"name", "score"} entries, no minimum/maximum), turned back into the dict the scoring code reads; the
default mode still sends the exact prompts it always did."""
import json
from pathlib import Path

import httpx
import pytest

import app.survey.keyed_calls as keyed_calls_module
from app.leveling.scoring import _parse_category_scores
from app.survey.keyed_calls import describe_output, items_schema, mode_for, output_lead, reset_degraded
from app.survey.keyed_specs import EPIC_FEATURE_SCORING_SPEC, SCORING_SPEC
from app.survey.orchestrator_llm_client import OrchestratorLlmClient, _with_category_dict

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "scoring_prompts_none.json").read_text())
DESCRIPTIONS = {"n1": "The unit shall do X.", "n2": "Size: 3U"}
EPICS = {"e1": {"type": "Epic", "text": "x"}, "f1": {"type": "Feature", "text": "y"}}


@pytest.fixture(autouse=True)
def _default_modes(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_mode", "none")
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "")
    reset_degraded()
    yield
    reset_degraded()


@pytest.fixture
def array_mode(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "scoring,epic_feature_scoring")


def _client(handler, cache=None) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache)
    client._transport = httpx.MockTransport(handler)
    return client


def _first_body(call) -> dict:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"content": "{}"})

    call(_client(handler))
    return seen[0]


# -- the default mode is exactly what prod already ran ----------------------------------------------


CASES = {
    "default": lambda c: c.score_requirements_for_document(DESCRIPTIONS),
    "checklist": lambda c: c.score_requirements_for_document(DESCRIPTIONS, category_checklist=["Necessary", "Verifiable"]),
    "kb": lambda c: c.score_requirements_for_document(DESCRIPTIONS, kb_context="KB material here"),
    "kb_checklist": lambda c: c.score_requirements_for_document(
        DESCRIPTIONS, kb_context="KB material", category_checklist=["Necessary", "Verifiable"],
    ),
    "criteria": lambda c: c.score_requirements_for_document(DESCRIPTIONS, criteria_context="criteria text"),
    "epic": lambda c: c.score_epics_and_features_for_document(EPICS),
}


@pytest.mark.parametrize("name", CASES)
def test_the_default_mode_sends_the_exact_prompt_it_always_did_and_no_schema(name) -> None:
    body = _first_body(CASES[name])
    assert body["messages"][0]["content"] == GOLDEN[name]
    assert "responseSchema" not in body


# -- the array wire format ---------------------------------------------------------------------------


def _walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


@pytest.mark.parametrize("spec", [SCORING_SPEC, EPIC_FEATURE_SCORING_SPEC])
def test_the_scoring_schemas_follow_the_vendor_rules_for_strict_structured_output(spec) -> None:
    schema = items_schema(spec)
    assert schema["strict"] is True
    for node in _walk(schema["schema"]):
        assert "minimum" not in node and "maximum" not in node  # unsupported; the range is checked where the score is read
        if node.get("type") == "object":
            assert node["additionalProperties"] is False and set(node["required"]) == set(node["properties"])
    assert not any(node.get("type") == "object" and "additionalProperties" in node and node["additionalProperties"] is not False
                   for node in _walk(schema["schema"]))  # no open map left anywhere


def test_the_scoring_schemas_do_not_grow_with_the_number_of_nodes() -> None:
    assert len(json.dumps(items_schema(SCORING_SPEC))) < 1500 and len(json.dumps(items_schema(EPIC_FEATURE_SCORING_SPEC))) < 800


def test_the_requirement_schema_keeps_every_field_the_scorer_reads() -> None:
    entry = items_schema(SCORING_SPEC)["schema"]["properties"]["items"]["items"]["properties"]
    assert set(entry) == {"id", "score", "issues", "categoryScores", "confidence"}
    assert entry["categoryScores"]["type"] == "array"
    assert set(entry["categoryScores"]["items"]["properties"]) == {"name", "score"}


def test_the_lead_clause_comes_from_the_same_place_as_the_other_passes() -> None:
    assert output_lead(SCORING_SPEC, "none") == "Return ONLY a JSON object with the SAME node_id keys, each mapped to an object with"
    assert output_lead(SCORING_SPEC, "array").startswith('Return ONLY a JSON object of the form {"items": [...]}')
    assert describe_output(SCORING_SPEC, "array").startswith(output_lead(SCORING_SPEC, "array")[:-1])


def test_modes_follow_the_named_passes(monkeypatch) -> None:
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "scoring")
    assert mode_for(SCORING_SPEC) == "array" and mode_for(EPIC_FEATURE_SCORING_SPEC) == "none"


def _array_answer(ids, categories=(("clarity", 80), ("testability", 60))):
    return {
        "items": [
            {
                "id": i, "score": 70, "issues": ["ambiguous"], "confidence": "high",
                "categoryScores": [{"name": n, "score": s} for n, s in categories],
            }
            for i in ids
        ]
    }


def test_requirement_scoring_in_array_mode_returns_the_dict_shape_the_scorer_reads(array_mode) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(200, json={"content": json.dumps(_array_answer(json.loads(body["messages"][1]["content"])))})

    result = _client(handler).score_requirements_for_document(DESCRIPTIONS)

    assert len(seen) == 1 and seen[0]["responseSchema"] == items_schema(SCORING_SPEC)
    assert result["n1"] == {
        "score": 70, "issues": ["ambiguous"], "confidence": "high",
        "categoryScores": {"clarity": 80, "testability": 60},
    }
    assert _parse_category_scores(result["n1"]["categoryScores"]) == {"clarity": 80, "testability": 60}


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({}, "an array of EXACTLY SIX"),
        ({"category_checklist": ["Necessary", "Verifiable"]}, "3 entries in total, never fewer"),
        ({"kb_context": "KB material"}, "whose NAMES you derive"),
    ],
)
def test_the_prompt_describes_the_category_list_the_schema_expects(array_mode, kwargs, expected) -> None:
    body = _first_body(lambda c: c.score_requirements_for_document(DESCRIPTIONS, **kwargs))
    prompt = body["messages"][0]["content"]
    assert expected in prompt and '{"name": <category>, "score": <integer 0-100>}' in prompt
    assert output_lead(SCORING_SPEC, "array") in prompt and "exactly 2 node_id(s)" in prompt
    assert "completeness_as_requirement" in prompt
    assert "an object with FIVE" not in prompt and "EXACTLY these categories as keys" not in prompt
    assert "FIVE" not in prompt  # the count and the list must agree: completeness_as_requirement is the sixth


def test_the_default_array_prompt_names_all_six_categories_and_says_none_may_be_left_out(array_mode) -> None:
    prompt = _first_body(lambda c: c.score_requirements_for_document(DESCRIPTIONS))["messages"][0]["content"]
    for name in ("clarity", "testability", "atomicity", "style", "rationale", "completeness_as_requirement"):
        assert name in prompt.split("never fewer")[0]  # the list sits in the same sentence as the count
    assert "score it 100 instead of leaving it out" in prompt


def test_the_checklist_names_still_reach_the_model_in_array_mode(array_mode) -> None:
    body = _first_body(lambda c: c.score_requirements_for_document(DESCRIPTIONS, category_checklist=["Necessary", "Verifiable"]))
    assert '["Necessary", "Verifiable"]' in body["messages"][0]["content"]


def test_epic_and_feature_scoring_in_array_mode(array_mode) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        ids = json.loads(body["messages"][1]["content"])
        items = [{"id": i, "score": 55, "categoryScores": [{"name": "scopeCoherence", "score": 50}]} for i in ids]
        return httpx.Response(200, json={"content": json.dumps({"items": items})})

    result = _client(handler).score_epics_and_features_for_document(EPICS)

    assert seen[0]["responseSchema"] == items_schema(EPIC_FEATURE_SCORING_SPEC)
    assert result == {i: {"score": 55, "categoryScores": {"scopeCoherence": 50}} for i in EPICS}
    prompt = seen[0]["messages"][0]["content"]
    assert "'categoryScores' (an array of" in prompt and "scopeCoherence" in prompt and "exactly 2 node_id(s)" in prompt


def test_a_legacy_map_answer_is_still_read_in_none_mode() -> None:
    legacy = {i: {"score": 70, "issues": [], "confidence": "high", "categoryScores": {"clarity": 80}} for i in DESCRIPTIONS}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": json.dumps(legacy)})

    assert _client(handler).score_requirements_for_document(DESCRIPTIONS) == legacy


def test_a_malformed_category_entry_is_skipped_and_other_shapes_are_left_alone() -> None:
    entry = {"score": 1, "categoryScores": [{"name": "clarity", "score": 80}, {"score": 5}, "x", {"name": 7, "score": 1}]}
    assert _with_category_dict(entry)["categoryScores"] == {"clarity": 80}
    assert _with_category_dict({"score": 1, "categoryScores": {"clarity": 5}}) == {"score": 1, "categoryScores": {"clarity": 5}}
    assert _with_category_dict("not an entry") == "not an entry"


def test_omitted_nodes_are_asked_for_again_once(array_mode) -> None:
    asked: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ids = list(json.loads(json.loads(request.content)["messages"][1]["content"]))
        asked.append(ids)
        return httpx.Response(200, json={"content": json.dumps(_array_answer(ids[:1] if len(asked) == 1 else ids))})

    result = _client(handler).score_requirements_for_document(DESCRIPTIONS)

    assert set(result) == set(DESCRIPTIONS) and asked == [["n1", "n2"], ["n2"]]


def test_an_answer_cut_off_by_the_token_limit_distrusts_its_last_node(array_mode) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        ids = list(json.loads(json.loads(request.content)["messages"][1]["content"]))
        # first call: cut off after n1 had been (partly) written; the retry gets the rest.
        if len(calls) == 1:
            return httpx.Response(200, json={"content": json.dumps(_array_answer(ids)), "finishReason": "length"})
        return httpx.Response(200, json={"content": json.dumps(_array_answer(ids))})

    result = _client(handler).score_requirements_for_document(DESCRIPTIONS)

    assert set(result) == {"n1", "n2"} and len(calls) == 2  # n2 was distrusted, asked again, and answered


class _Cache:
    def __init__(self) -> None:
        self.stored: dict = {}

    def get(self, key):
        return self.stored.get(key)

    def set(self, key, value) -> None:
        self.stored[key] = value


def test_only_a_complete_answer_is_cached(array_mode) -> None:
    def complete(request: httpx.Request) -> httpx.Response:
        ids = list(json.loads(json.loads(request.content)["messages"][1]["content"]))
        return httpx.Response(200, json={"content": json.dumps(_array_answer(ids))})

    def partial(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": json.dumps(_array_answer(["n1"]))})

    cache = _Cache()
    _client(partial, cache).score_requirements_for_document(DESCRIPTIONS)
    assert cache.stored == {}
    _client(complete, cache).score_requirements_for_document(DESCRIPTIONS)
    assert len(cache.stored) == 1
