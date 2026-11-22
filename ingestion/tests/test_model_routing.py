"""The gateway's `Auto` (production finding F7): a router, not a model. The orchestrator passes on the model it sent each call to when the
answer's headers named it. Per-model state is keyed by that model, an answer without it leaves `Auto` its own unknown model, and every
work item records which model answered each prompt it used."""

import json

import httpx
import pytest

import app.survey.keyed_calls as keyed_calls_module
from app.survey.keyed_calls import (
    KeyedSpec,
    is_degraded,
    note_answered_by,
    reset_degraded,
    run_keyed,
)
from app.survey.keyed_specs import SCORING_SPEC
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import PROMPT_KEY, PromptRef, WorkItemNode, record_prompt
from tests._prod_replay import answer, keyed_answer, replay


@pytest.fixture(autouse=True)
def _array_mode(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_mode", "array")
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "")
    reset_degraded()
    yield
    reset_degraded()


def _client(handler) -> OrchestratorLlmClient:
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t", model="Auto")
    client._transport = httpx.MockTransport(handler)
    return client


LEVELS = {
    "categories": [
        {"name": name, "level": 4, "evidence": ""}
        for name in ("clarity", "testability", "atomicity", "completeness_as_requirement")
    ],
    "findings": [],
}
TEXTS = {"n1": "The unit shall supply 28 V."}


def _models(entry: dict) -> list[str | None]:
    tags = entry[PROMPT_KEY]
    return [tag.get("model") for tag in (tags if isinstance(tags, list) else [tags])]


def test_each_scoring_vote_records_the_model_the_router_sent_it_to() -> None:
    handler, _ = replay(
        lambda r: keyed_answer({"n1": LEVELS}, routed_to="OpenAI/gpt-5.4"),
        lambda r: keyed_answer({"n1": LEVELS}, routed_to="claude-opus-5-5"),
    )
    result = _client(handler).score_requirements_for_document(TEXTS)
    # Votes from two models are both recorded, so a reader sees the score mixes them.
    assert _models(result["n1"]) == ["OpenAI/gpt-5.4", "claude-opus-5-5"]


def test_an_answer_that_names_no_routed_model_records_the_requested_name() -> None:
    handler, _ = replay(lambda r: keyed_answer({"n1": LEVELS}), lambda r: keyed_answer({"n1": LEVELS}))
    assert _models(_client(handler).score_requirements_for_document(TEXTS)["n1"]) == ["Auto"]


def test_a_pass_degraded_by_a_routed_model_is_degraded_for_that_model_not_for_auto() -> None:
    # The router sends the schema call to a model that answers garbage, and the prompt-only call to one that answers.
    handler, _ = replay(
        lambda r: answer("{}", routed_to="OpenAI/gpt-5-mini"),
        lambda r: answer(json.dumps({"n1": LEVELS}), routed_to="claude-opus-5-5"),
        lambda r: keyed_answer({"n1": LEVELS}, routed_to="claude-opus-5-5"),
    )
    _client(handler).score_requirements_for_document(TEXTS)
    assert is_degraded(SCORING_SPEC, "OpenAI/gpt-5-mini")
    assert not is_degraded(SCORING_SPEC, "Auto")


SPEC = KeyedSpec(name="probe", schema_name="probe", fields={"value": {"type": "integer"}}, field_prompts={"value": "'value'"}, id_noun="id")


def test_without_a_routed_model_the_degraded_pass_is_kept_under_the_requested_name() -> None:
    def send(payload: dict, mode: str) -> object:
        note_answered_by(None)
        return {} if mode == "array" else {key: {"value": 1} for key in payload}

    run_keyed(send, {"a": "x"}, SPEC, model="Auto")
    assert is_degraded(SPEC, "Auto")


def test_record_prompt_keeps_one_ref_per_answering_model() -> None:
    node = WorkItemNode.model_construct(prompts=[])  # record_prompt reads and writes nothing else
    tag = {"name": "p", "version": 1, "sha256": "s"}
    record_prompt(node, {PROMPT_KEY: [{**tag, "model": "a"}, {**tag, "model": "b"}]})
    record_prompt(node, {PROMPT_KEY: {**tag, "model": "a"}})
    assert node.prompts == [PromptRef(**tag, model="a"), PromptRef(**tag, model="b")]
