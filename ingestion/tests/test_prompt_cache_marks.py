"""The stable start of a call's user message (the blocks that are the same on every call of a job: knowledge-base text, the rubric, the
organization's conventions, a fixed vocabulary) can be marked as a prompt-cache breakpoint. The two parts always join back to the exact
message, and with the setting off nothing changes."""

import json

import httpx
import pytest

from app.prompts.assembly import DataBlock, build_call
from app.survey import orchestrator_llm_client as client_module
from app.survey.orchestrator_llm_client import OrchestratorLlmClient


def _scoring_like():
    return build_call(
        "name_root_groups",
        blocks=[
            DataBlock("reference", "kb text"),
            DataBlock("source", '["clarity"]', tag="category_names"),
            DataBlock("source", "items of this call"),
        ],
    )


def test_the_stable_prefix_ends_after_the_last_stable_leading_block() -> None:
    call = _scoring_like()
    assert call.cache_prefix > 0
    assert call.user[: call.cache_prefix].endswith("</category_names>")
    assert call.user[: call.cache_prefix] + call.user[call.cache_prefix :] == call.user


def test_a_call_that_starts_with_its_own_items_has_no_stable_prefix() -> None:
    call = build_call("name_root_groups", blocks=[DataBlock("source", "items"), DataBlock("reference", "kb")])
    assert call.cache_prefix == 0


def test_criteria_retrieved_per_batch_end_the_stable_prefix() -> None:
    call = build_call(
        "name_root_groups",
        blocks=[DataBlock("rubric", "rules"), DataBlock("reference", "per batch", tag="criteria"), DataBlock("source", "items")],
    )
    assert call.user[: call.cache_prefix].endswith("</rubric>")


def _sent(monkeypatch, on: bool) -> dict:  # noqa: ANN001
    monkeypatch.setattr(client_module.settings, "llm_prompt_cache", on)
    monkeypatch.setattr(client_module.settings, "live_progress", False)
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    client._chat_json(_scoring_like(), client._params(schema=None), user_id="u1")
    return seen[0]


def test_with_caching_on_the_user_message_is_sent_as_two_parts_the_first_marked(monkeypatch) -> None:  # noqa: ANN001
    call = _scoring_like()
    user = _sent(monkeypatch, True)["messages"][-1]
    assert user["content"] == [
        {"type": "text", "text": call.user[: call.cache_prefix], "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": call.user[call.cache_prefix :]},
    ]


def test_with_caching_off_the_request_is_exactly_as_before(monkeypatch) -> None:  # noqa: ANN001
    call = _scoring_like()
    assert _sent(monkeypatch, False)["messages"] == call.messages()


@pytest.mark.parametrize("on", [True, False])
def test_the_system_message_is_left_to_the_orchestrator(monkeypatch, on) -> None:  # noqa: ANN001
    # The orchestrator marks the system message for a Claude model; ingestion never changes it.
    assert _sent(monkeypatch, on)["messages"][0] == {"role": "system", "content": _scoring_like().system}
