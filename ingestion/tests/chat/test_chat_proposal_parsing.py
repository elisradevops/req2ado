"""A reply that announces a rewrite must deliver it, and a proposal that was written must not be lost to formatting.

Prod: the answer ended 'Here is a conservative rewrite:' and no proposal appeared. Replayed on Opus, 2 of 3 runs wrote no marker at all
(they asked for the missing facts, as the prompt tells them to), and one wrote it with valid JSON. Nothing said which case a turn was."""
import logging

import pytest

from app.chat import chat_service
from app.chat.chat_client import PROPOSAL_SENTINEL, proposal_failure_reason, split_message_and_proposal
from app.chat.chat_service import _build_system_prompt, run_chat_turn
from tests.chat.test_chat_service import _FakePublisher

M = PROPOSAL_SENTINEL
JSON = '{"proposedTitle": "New", "proposedDescription": "The unit shall start within 10 s."}'


@pytest.mark.parametrize("tail", [JSON, f"```json\n{JSON}\n```", f"```\n{JSON}\n```", f"Here it is: {JSON}", f"{JSON}\n\nLet me know if you want changes.", f"\n\n  {JSON}  "])
def test_a_written_proposal_is_read_whatever_surrounds_the_json(tail) -> None:
    message, title, description = split_message_and_proposal(f"Sure.\n{M}\n{tail}")
    assert (message, title, description) == ("Sure.", "New", "The unit shall start within 10 s.")


@pytest.mark.parametrize(
    "reply, reason",
    [
        ("Please tell me the unit first.", "no_marker"),
        (f"Sure.\n{M}\n", "no_object"),
        (f"Sure.\n{M}\nthe rewrite is above", "no_object"),
        (f"Sure.\n{M}\n{{not json", "invalid_json"),
        (f"Sure.\n{M}\n[1, 2]", "no_object"),
        (f'Sure.\n{M}\n{{"proposedTitle": null, "proposedDescription": null}}', "no_text"),
        (f'Sure.\n{M}\n{{"proposedTitle": 5, "proposedDescription": 6}}', "no_text"),
        (f"Sure.\n{M}\n{JSON}", None),
    ],
)
def test_the_reason_a_proposal_is_missing_is_named(reply, reason) -> None:
    assert proposal_failure_reason(reply) == reason


def test_the_split_still_gives_no_proposal_for_every_failing_case() -> None:
    for reply in ("No marker.", f"x\n{M}\n{{not json", f"x\n{M}\n[]", f'x\n{M}\n{{"proposedTitle": 1}}'):
        _message, title, description = split_message_and_proposal(reply)
        assert title is None and description is None


def test_the_prompt_says_to_ask_or_to_propose_never_to_announce_a_rewrite_it_does_not_deliver() -> None:
    prompt = _build_system_prompt({"type": "Requirement", "title": "T", "description": "D", "qualityIssues": []}, None, None).lower()
    assert "never announce a rewrite" in prompt
    assert "same reply" in prompt
    assert "ask" in prompt and "or" in prompt


class _Replying:
    def __init__(self, text: str) -> None:
        self.text = text

    async def stream_reply(self, messages, model, user_id=None):  # noqa: ANN001, ARG002
        yield self.text, ""


ITEM = {"type": "Requirement", "title": "Lock", "description": "The receiver shall lock.", "qualityIssues": []}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply, expected",
    [
        ("Here is a conservative rewrite:", "proposal=none reason=no_marker announced=yes"),
        ("What is the unit?", "proposal=none reason=no_marker announced=no"),
        (f"Sure.\n{M}\n{{not json", "proposal=none reason=invalid_json announced=no"),
        (f"Sure.\n{M}\n{JSON}", "proposal=yes"),
    ],
)
async def test_a_turn_logs_whether_it_produced_a_proposal_and_why_not_without_any_text(reply, expected, caplog) -> None:
    with caplog.at_level(logging.INFO, logger="app.chat.chat_service"):
        await run_chat_turn("job-1", "n1", dict(ITEM), [], "improve this", "m", None, None, None, _Replying(reply), _FakePublisher(), None)
    line = next(r.getMessage() for r in caplog.records if "chat turn result" in r.getMessage())
    assert expected in line
    assert "conservative" not in line and "unit" not in line  # never the reply's text
