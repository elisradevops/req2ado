"""Quality scoring on the keyed-result module: the model returns an anchored level per category (with its evidence) and quoted findings;
code computes the entry the scoring code reads (app.leveling.score_levels) from two votes, the second over the items in reverse order."""

import json
from pathlib import Path

import httpx
import pytest

import app.survey.keyed_calls as keyed_calls_module
import app.survey.orchestrator_llm_client as client_module
from app.kb.profile import RubricText
from app.language_policy import LanguagePolicy
from app.leveling.scoring import _parse_category_scores
from app.prompts.assembly import block_text
from app.survey.keyed_calls import (
    describe_output,
    items_schema,
    mode_for,
    output_lead,
    reset_degraded,
)
from app.survey.keyed_specs import SCORING_SPEC
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from tests._prompt_tags import untagged

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "scoring_prompts_none.json").read_text())
DESCRIPTIONS = {"n1": "The unit shall do X.", "n2": "Size: 3U"}


@pytest.fixture(autouse=True)
def _default_modes(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_mode", "none")
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "")
    reset_degraded()
    yield
    reset_degraded()


@pytest.fixture
def array_mode(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "scoring")


def _client(handler, cache=None) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient(
        base_url="http://orchestrator.internal", bearer_token="test-bearer", cache=cache
    )
    client._transport = httpx.MockTransport(handler)
    return client


def _bodies(call, client_setup=None) -> list[dict]:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"content": "{}"})

    client = _client(handler)
    if client_setup is not None:
        client_setup(client)
    call(client)
    return seen


def _ids(body: dict) -> list[str]:
    return list(json.loads(block_text(body["messages"][1]["content"])))


# -- the default mode (prompt-only) ------------------------------------------------------------------


CASES = {
    "default": lambda c: c.score_requirements_for_document(DESCRIPTIONS),
    "checklist": lambda c: c.score_requirements_for_document(
        DESCRIPTIONS, category_checklist=["Necessary", "Verifiable"]
    ),
    "kb": lambda c: c.score_requirements_for_document(DESCRIPTIONS, kb_context="KB material here"),
    "kb_checklist": lambda c: c.score_requirements_for_document(
        DESCRIPTIONS,
        kb_context="KB material",
        category_checklist=["Necessary", "Verifiable"],
    ),
    "criteria": lambda c: c.score_requirements_for_document(
        DESCRIPTIONS, criteria_context="criteria text"
    ),
}


@pytest.mark.parametrize("name", CASES)
def test_the_default_mode_sends_the_reviewed_prompt_and_no_schema(name) -> None:
    body = _bodies(CASES[name])[0]
    assert body["messages"][0]["content"] == GOLDEN[name]
    assert "responseSchema" not in body


@pytest.mark.parametrize("name", CASES)
def test_every_scoring_mode_says_a_requirement_and_its_own_verification_are_one_obligation(name) -> None:
    # GPT sometimes tagged "... shall supply 28 V ..., and shall be verified by test 4.2" as compound (production finding F6).
    prompt = _bodies(CASES[name])[0]["messages"][0]["content"]
    assert "together with the way it is verified" in prompt


def test_the_built_in_atomicity_anchor_says_a_requirement_and_its_own_verification_are_one_obligation() -> None:
    anchor = next(
        line for line in _bodies(CASES["default"])[0]["messages"][0]["content"].splitlines() if "- atomicity:" in line
    )
    assert "together with the way it is verified" in anchor


# -- the wire format ---------------------------------------------------------------------------------


def _walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def test_the_scoring_schema_follows_the_vendor_rules_for_strict_structured_output() -> None:
    schema = items_schema(SCORING_SPEC)
    assert schema["strict"] is True
    for node in _walk(schema["schema"]):
        assert (
            "minimum" not in node and "maximum" not in node
        )  # the 0-4 range is checked where a level is read
        if node.get("type") == "object":
            assert node["additionalProperties"] is False and set(node["required"]) == set(
                node["properties"]
            )


def test_the_scoring_schema_does_not_grow_with_the_number_of_nodes() -> None:
    assert len(json.dumps(items_schema(SCORING_SPEC))) < 1500


def test_the_model_gives_levels_and_quoted_findings_never_a_score_or_a_confidence() -> None:
    entry = items_schema(SCORING_SPEC)["schema"]["properties"]["items"]["items"]["properties"]
    assert set(entry) == {"id", "categories", "findings"}
    assert set(entry["categories"]["items"]["properties"]) == {"name", "level", "evidence"}
    assert set(entry["findings"]["items"]["properties"]) == {"issue", "quote"}
    assert "conflicting_value" not in entry["findings"]["items"]["properties"]["issue"]["enum"]


def test_the_lead_clause_comes_from_the_same_place_as_the_other_passes() -> None:
    assert (
        output_lead(SCORING_SPEC, "none")
        == "Return ONLY a JSON object with the SAME node_id keys, each mapped to an object with"
    )
    assert describe_output(SCORING_SPEC, "array").startswith(
        output_lead(SCORING_SPEC, "array")[:-1]
    )


def test_modes_follow_the_named_passes(monkeypatch) -> None:
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "scoring")
    assert mode_for(SCORING_SPEC) == "array"


def _levels(ids, level=4, completeness=4, findings=()):
    return {
        "items": [
            {
                "id": i,
                "categories": [
                    {"name": "clarity", "level": level, "evidence": ""},
                    {"name": "testability", "level": level, "evidence": ""},
                    {"name": "completeness_as_requirement", "level": completeness, "evidence": ""},
                ],
                "findings": [{"issue": f, "quote": q} for f, q in findings],
            }
            for i in ids
        ]
    }


def _answering(answer_for):
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(200, json={"content": json.dumps(answer_for(len(seen), _ids(body)))})

    return handler, seen


def test_two_votes_the_second_in_reverse_order_and_code_computes_the_entry(array_mode) -> None:
    handler, seen = _answering(
        lambda call, ids: _levels(
            ids, level=3 if call == 1 else 2, findings=[("vague_term", "do X")]
        )
    )
    result = _client(handler).score_requirements_for_document(DESCRIPTIONS)

    assert [_ids(b) for b in seen] == [["n1", "n2"], ["n2", "n1"]]
    assert seen[0]["responseSchema"] == items_schema(SCORING_SPEC)
    # levels 3 and 2 average to 2.5 (62.5 -> 62); completeness 4 does not gate it; the finding's quote is in n1 only.
    assert untagged(result)["n1"] == {
        "score": 62,
        "issues": ["vague_term"],
        "categoryScores": {"clarity": 62, "testability": 62, "completeness_as_requirement": 100},
        "confidence": "high",
    }
    assert result["n2"]["issues"] == []
    assert _parse_category_scores(result["n1"]["categoryScores"]) == result["n1"]["categoryScores"]


def test_votes_that_disagree_on_whether_it_is_a_requirement_give_a_low_confidence(
    array_mode,
) -> None:
    handler, _ = _answering(lambda call, ids: _levels(ids, completeness=4 if call == 1 else 0))
    result = _client(handler).score_requirements_for_document(DESCRIPTIONS)
    assert result["n1"]["confidence"] == "low"
    assert "not_a_requirement" not in result["n1"]["issues"]  # the mean level, 2, states no issue


def test_a_failed_second_vote_leaves_one_vote_and_a_medium_confidence(
    array_mode, monkeypatch
) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) > 1:
            return httpx.Response(500, json={})
        return httpx.Response(200, json={"content": json.dumps(_levels(DESCRIPTIONS))})

    monkeypatch.setattr(client_module.time, "sleep", lambda _seconds: None)
    client = _client(handler)
    result = client.score_requirements_for_document(DESCRIPTIONS)
    assert result["n1"]["confidence"] == "medium" and result["n1"]["score"] == 100


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({}, "EXACTLY 4"),
        ({"category_checklist": ["Necessary", "Verifiable"]}, "3 entries in total, never fewer"),
        ({"kb_context": "KB material"}, "Decide the names ONCE"),
    ],
)
def test_the_prompt_describes_the_category_list_the_schema_expects(
    array_mode, kwargs, expected
) -> None:
    prompt = _bodies(lambda c: c.score_requirements_for_document(DESCRIPTIONS, **kwargs))[0][
        "messages"
    ][0]["content"]
    assert expected in prompt and '{"name", "level", "evidence"}' in prompt
    assert output_lead(SCORING_SPEC, "array") in prompt and "exactly 2 node_id(s)" in prompt
    assert "completeness_as_requirement: 4 = a complete requirement" in prompt
    assert "'score' (an integer 0-100)" not in prompt and "'confidence'" not in prompt


def test_the_checklist_names_reach_the_model_with_the_completeness_check() -> None:
    body = _bodies(
        lambda c: c.score_requirements_for_document(
            DESCRIPTIONS, category_checklist=["Necessary", "Verifiable"]
        )
    )[0]
    assert (
        block_text(body["messages"][1]["content"], "category_names")
        == '["Necessary", "Verifiable", "completeness_as_requirement"]'
    )


def test_the_organizations_rubric_is_authoritative_and_retrieved_chunks_are_reference() -> None:
    body = _bodies(
        lambda c: c.score_requirements_for_document(DESCRIPTIONS, kb_context=RubricText("R"))
    )[0]
    system, user = (m["content"] for m in body["messages"])
    assert block_text(user, "rubric") == "R" and block_text(user, "reference") is None
    assert "The <rubric> block is this organization's own standard" in system
    assert "may be incomplete or irrelevant" not in system

    body = _bodies(lambda c: c.score_requirements_for_document(DESCRIPTIONS, kb_context="chunks"))[
        0
    ]
    system, user = (m["content"] for m in body["messages"])
    assert block_text(user, "reference") == "chunks" and block_text(user, "rubric") is None


def test_the_obligation_form_and_hebrew_text_reach_the_model_as_written() -> None:
    hebrew = {"h1": "היחידה תעבור בדיקת סביבה"}

    def setup(client: OrchestratorLlmClient) -> None:
        client.language_policy = LanguagePolicy("HEBREW", ("היחידה תעבור",), "document")

    body = _bodies(lambda c: c.score_requirements_for_document(hebrew), setup)[0]
    system, user = (m["content"] for m in body["messages"])
    assert block_text(user, "obligation_forms") == "היחידה תעבור"
    assert "היחידה תעבור" not in system and "shows how this document states an obligation" in system
    assert "היחידה תעבור בדיקת סביבה" in block_text(user)  # not \\u-escaped


def test_omitted_nodes_are_asked_for_again_once_per_vote(array_mode) -> None:
    handler, seen = _answering(lambda call, ids: _levels(ids[:1] if call in (1, 3) else ids))
    result = _client(handler).score_requirements_for_document(DESCRIPTIONS)
    assert set(result) == set(DESCRIPTIONS)
    assert [_ids(b) for b in seen] == [["n1", "n2"], ["n2"], ["n2", "n1"], ["n1"]]


def test_an_answer_cut_off_by_the_token_limit_distrusts_its_last_node(array_mode) -> None:
    seen: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ids = _ids(json.loads(request.content))
        seen.append(ids)
        cut = {"finishReason": "length"} if len(seen) == 1 else {}
        return httpx.Response(200, json={"content": json.dumps(_levels(ids)), **cut})

    result = _client(handler).score_requirements_for_document(DESCRIPTIONS)
    assert set(result) == {"n1", "n2"} and seen[1] == ["n2"]  # n2 was distrusted and asked again


class _Cache:
    def __init__(self) -> None:
        self.stored: dict = {}

    def get(self, key):
        return self.stored.get(key)

    def set(self, key, value) -> None:
        self.stored[key] = value


def test_each_complete_vote_is_cached_raw_and_scored_after_the_cache(array_mode) -> None:
    def partial(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": json.dumps(_levels(["n1"]))})

    cache = _Cache()
    _client(partial, cache).score_requirements_for_document(DESCRIPTIONS)
    assert cache.stored == {}

    handler, _ = _answering(lambda call, ids: _levels(ids))
    first = _client(handler, cache).score_requirements_for_document(DESCRIPTIONS)
    assert len(cache.stored) == 2
    assert all("categories" in entry for vote in cache.stored.values() for entry in vote.values())

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise AssertionError("both votes are cached")

    assert _client(unreachable, cache).score_requirements_for_document(DESCRIPTIONS) == first
