"""Every evaluation case runs offline against a scripted good model and a scripted bad model: the good answer must pass every check and the
bad answer must fail at least one. A check that cannot fail measures nothing."""

from __future__ import annotations

import json

import httpx
import pytest

from app.survey.orchestrator_llm_client import OrchestratorLlmClient

from .cases import CASES, Case
from .compare import regressions
from .harness import AsUser, evaluate, prompt_identity, run_all


def _client(replies: list[str]) -> tuple[OrchestratorLlmClient, list[dict]]:
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        reply = replies[min(len(sent), len(replies)) - 1]
        return httpx.Response(200, json={"content": reply, "finishReason": "stop"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    return client, sent


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c.family}/{c.name}")
def test_a_good_answer_passes_every_check(case: Case) -> None:
    client, _ = _client(case.good)
    outcome = evaluate(case, client)
    assert outcome["passed"], outcome


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c.family}/{c.name}")
def test_a_bad_answer_fails_a_check(case: Case) -> None:
    client, _ = _client(case.bad)
    outcome = evaluate(case, client)
    assert not outcome["passed"]
    assert "error" not in outcome, (
        outcome
    )  # it must fail on a check, not because the reply could not be read


def test_a_live_run_sends_the_user_id_on_every_call() -> None:
    users: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        users.append(request.headers.get("x-req2ado-user-id"))
        return httpx.Response(200, json={"content": "{}", "finishReason": "stop"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    run_all(AsUser(client, "eval-user"))
    assert users and set(users) == {"eval-user"}


def test_every_case_names_a_real_prompt() -> None:
    for case in CASES:
        assert prompt_identity(case.family)["version"] >= 1


def test_case_names_are_unique() -> None:
    keys = [f"{c.family}/{c.name}" for c in CASES]
    assert len(keys) == len(set(keys))


def _report(**passed: bool) -> dict:
    return {
        "model": "m",
        "cases": {k: {"passed": v, "checks": {"c": {"ok": v}}} for k, v in passed.items()},
    }


def test_the_gate_reports_a_case_that_got_worse() -> None:
    assert regressions(_report(a=True, b=False), _report(a=False, b=False)) == [
        "a/c: passed before, fails now ()"
    ]


def test_the_gate_accepts_an_improvement() -> None:
    assert regressions(_report(a=True, b=False), _report(a=True, b=True)) == []


def test_the_gate_reports_a_missing_case() -> None:
    assert regressions(_report(a=True), {"model": "m", "cases": {}}) == [
        "a: missing from the new report"
    ]


def test_author_content_checks_catch_a_dropped_value_and_added_emphasis() -> None:
    from .cases import _HE_GOOD, _HE_SECTION, _check_author

    content = json.loads(_HE_GOOD)
    content["r2"]["description"] = "במצב חיסכון צריכת ההספק **לא תעלה** על הסף."
    checks = _check_author((content, False), _HE_SECTION)
    assert not checks["keeps_values"][0] and "r2:number:5" in checks["keeps_values"][1]
    assert not checks["no_emphasis"][0]
    assert checks["no_invented_values"][0]
