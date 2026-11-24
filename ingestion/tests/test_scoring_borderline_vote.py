"""Scoring writes less: the second vote is asked only for the items whose first-vote levels sit on an issue threshold or one step above it
(the only items a single level step could change), and no category carries an evidence quote nobody reads."""

import json

import httpx
import pytest

from app.leveling.score_levels import entry_from_votes, is_borderline
from app.prompts import load_prompt
from app.prompts.assembly import block_text
from app.survey import keyed_calls as keyed_calls_module
from app.survey.keyed_calls import reset_degraded
from app.survey.keyed_specs import SCORING_SPEC
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

DESCRIPTIONS = {"n1": "The unit shall do X.", "n2": "The unit shall do Y."}


@pytest.fixture(autouse=True)
def _array_mode(monkeypatch):  # noqa: ANN001, ANN202
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_mode", "none")
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "scoring")
    reset_degraded()
    yield
    reset_degraded()


def _answer(levels_by_id: dict[str, dict[str, int]]) -> dict:
    return {
        "items": [
            {"id": i, "categories": [{"name": n, "level": lv} for n, lv in levels.items()], "findings": []}
            for i, levels in levels_by_id.items()
        ]
    }


CLEAR = {"clarity": 4, "testability": 4, "completeness_as_requirement": 4}
BORDERLINE = {"clarity": 4, "testability": 2, "completeness_as_requirement": 4}


@pytest.mark.parametrize(
    ("levels", "expected"),
    [
        (CLEAR, False),
        ({"clarity": 3, "testability": 4, "completeness_as_requirement": 4}, False),  # clarity issue at <=1: 3 is two steps away
        ({"clarity": 2, "testability": 4, "completeness_as_requirement": 4}, True),  # one step above "ambiguous"
        ({"testability": 3, "completeness_as_requirement": 4}, True),  # one step above "missing acceptance criteria" (<=2)
        ({"testability": 4, "completeness_as_requirement": 2}, True),  # one step above "fragment" (<=1)
        ({"Necessary": 1, "completeness_as_requirement": 4}, False),  # an organization's own category states no level issue
    ],
)
def test_borderline_means_one_level_step_could_change_an_issue(levels, expected) -> None:  # noqa: ANN001
    assert is_borderline(levels) is expected


def test_one_clear_vote_is_a_high_confidence_and_one_borderline_vote_a_medium_one() -> None:
    clear = _answer({"n": CLEAR})["items"][0]
    borderline = _answer({"n": BORDERLINE})["items"][0]
    assert entry_from_votes([clear], "The unit shall do X.")["confidence"] == "high"
    assert entry_from_votes([borderline], "The unit shall do X.")["confidence"] == "medium"


def _run(first_vote: dict[str, dict[str, int]]):  # noqa: ANN202
    seen: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        ids = list(json.loads(block_text(body["messages"][1]["content"])))
        seen.append(ids)
        answer = {i: first_vote[i] for i in ids} if len(seen) == 1 else {i: BORDERLINE for i in ids}
        return httpx.Response(200, json={"content": json.dumps(_answer(answer))})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    return client.score_requirements_for_document(DESCRIPTIONS), seen


def test_only_the_borderline_items_get_a_second_vote() -> None:
    result, seen = _run({"n1": CLEAR, "n2": BORDERLINE})
    assert seen == [["n1", "n2"], ["n2"]]
    assert result["n1"]["confidence"] == "high"
    assert result["n2"]["confidence"] == "high"  # two agreeing votes


def test_a_batch_with_no_borderline_item_is_asked_once() -> None:
    result, seen = _run({"n1": CLEAR, "n2": CLEAR})
    assert seen == [["n1", "n2"]]
    assert {r["confidence"] for r in result.values()} == {"high"}


def test_no_category_carries_an_evidence_quote() -> None:
    category = SCORING_SPEC.fields["categories"]["items"]
    assert set(category["properties"]) == {"name", "level"} and category["required"] == ["name", "level"]
    assert "evidence" not in SCORING_SPEC.field_prompts["categories"]
    for fragment in ("fragment_scoring_levels_builtin", "fragment_scoring_levels_derived", "fragment_scoring_levels_checklist"):
        assert "evidence" not in load_prompt(fragment, **_markers(fragment)).lower(), fragment


def _markers(fragment: str) -> dict:
    from app.prompts import _latest_version, _read

    text = _read(fragment, _latest_version(fragment))
    import re

    return {m.lower(): "x" for m in re.findall(r"__([A-Z_]+)__", text)}
