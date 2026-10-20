"""The chat knows where the item sits in the document and what the knowledge base requires before it suggests anything.

Before: the prompt carried the item's own text, two weak categories and chunks retrieved by the user's message ("improve this"
retrieves near-random chunks). Nothing said which Feature the item belongs to, what its neighbours say, or what the organization's
rules and definitions are, and nothing bounded the rewrite."""
import logging

import pytest

from app.chat import chat_service
from app.chat.chat_service import _build_system_prompt, run_chat_turn
from app.chat.context_pack import MAX_CONTEXT_CHARS, render_context_pack
from app.kb.profile import build_profile
from tests.chat.test_chat_service import _FakePublisher
from tests.test_kb_profile import DOCS, FakeProfileClient

PROFILE = build_profile(DOCS, FakeProfileClient(), model="m1")
ITEM = {"type": "Requirement", "title": "Receiver lock time", "description": "The receiver shall lock within 5 ms.", "qualityIssues": []}
CONTEXT = {
    "documentName": "AirPro ICD",
    "parents": [
        {"type": "Epic", "title": "RF front end", "description": "Everything between the antenna and the ADC."},
        {"type": "Feature", "title": "Carrier acquisition", "description": "How the receiver finds and holds the carrier."},
    ],
    "siblings": [{"title": "Loss of lock reporting"}, {"title": "Re-acquisition retries"}],
    "linked": [{"relation": "Affects", "title": "Filter settling time"}],
    "figures": [{"name": "Lock state machine", "caption": "States from idle to locked."}],
    "tables": [{"caption": "Acquisition timing limits"}],
}


def test_the_pack_says_where_the_item_sits_and_what_surrounds_it() -> None:
    text = render_context_pack(CONTEXT)
    assert "AirPro ICD" in text
    assert text.index("RF front end") < text.index("Carrier acquisition")  # root first
    assert "Everything between the antenna and the ADC." in text
    assert "Loss of lock reporting" in text and "Re-acquisition retries" in text
    assert "Affects" in text and "Filter settling time" in text
    assert "Lock state machine" in text and "Acquisition timing limits" in text


def test_the_pack_is_bounded() -> None:
    big = {
        "parents": [{"type": "Feature", "title": "F", "description": "d" * 5000}],
        "siblings": [{"title": f"Sibling number {i}"} for i in range(80)],
        "linked": [{"relation": "Related", "title": f"Linked {i}"} for i in range(80)],
        "figures": [{"name": f"Fig {i}", "caption": "c" * 900} for i in range(40)],
        "tables": [{"caption": "t" * 900} for i in range(40)],
    }
    text = render_context_pack(big)
    assert len(text) <= MAX_CONTEXT_CHARS
    assert "Sibling number 0" in text and "Sibling number 79" not in text


@pytest.mark.parametrize("empty", [None, {}, {"parents": [], "siblings": [], "linked": [], "figures": [], "tables": []}, {"documentName": ""}])
def test_nothing_is_rendered_when_there_is_no_context(empty) -> None:
    assert render_context_pack(empty) is None


def test_malformed_context_is_ignored_not_fatal() -> None:
    rendered = render_context_pack({"parents": "x", "siblings": [1, None, {"title": 5}], "linked": [{"title": None}], "figures": [3]})
    assert rendered is None or isinstance(rendered, str)
    ok = render_context_pack({"parents": [{"type": "Feature", "title": "Real"}, "junk", {"title": None}]})
    assert ok is not None and "Real" in ok


def test_the_prompt_leads_with_the_standard_then_the_document_then_the_item() -> None:
    prompt = _build_system_prompt(ITEM, None, None, context=CONTEXT, standard="STANDARD TEXT: every rule and definition")
    assert prompt.index("STANDARD TEXT") < prompt.index("RF front end") < prompt.index("Receiver lock time")


def test_the_prompt_carries_the_rewrite_rules() -> None:
    prompt = _build_system_prompt(ITEM, None, None)
    lowered = prompt.lower()
    assert "one requirement" in lowered or "single requirement" in lowered
    assert "keep the title" in lowered
    assert "number" in lowered and "unit" in lowered and "identifier" in lowered
    assert "ask" in lowered and "invent" in lowered  # missing information is asked for, never made up
    assert "times the length" in lowered or "no longer than" in lowered


def test_the_prompt_is_unchanged_in_shape_without_context_or_standard() -> None:
    prompt = _build_system_prompt(ITEM, None, "WEAK NOTE.")
    assert "WEAK NOTE." in prompt and "Receiver lock time" in prompt
    assert "Where this item sits" not in prompt


class _Capturing:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def stream_reply(self, messages, model, user_id=None):  # noqa: ANN001, ARG002
        self.messages = messages
        yield "ok", ""


@pytest.mark.asyncio
async def test_a_turn_sends_the_standard_and_the_context_and_retrieves_by_the_item_not_the_message(monkeypatch) -> None:
    queries: list[str] = []

    def fake_retrieve(user_id, query, embed_client, vector_store):  # noqa: ANN001, ARG001
        queries.append(query)
        return "KB CHUNK ABOUT LOCK TIMES", []

    monkeypatch.setattr(chat_service, "retrieve_context", fake_retrieve)
    client = _Capturing()
    await run_chat_turn(
        "job-1", "n1", {**ITEM, "context": CONTEXT}, [], "improve this", "m", "u1", object(), object(), client, _FakePublisher(), PROFILE,
    )
    system = client.messages[0]["content"]
    assert "Carrier acquisition" in system and "Filter settling time" in system  # the document
    assert "One reading only" in system or "Can be verified" in system  # the organization's own pass conditions (the standard)
    assert "KB CHUNK ABOUT LOCK TIMES" in system
    assert "Receiver lock time" in queries[0] and "lock within 5 ms" in queries[0]  # by the item's own text
    assert "improve this" in queries[0]  # and by what was asked


@pytest.mark.asyncio
async def test_a_turn_without_context_or_profile_still_works(caplog) -> None:
    client = _Capturing()
    with caplog.at_level(logging.INFO, logger="app.chat.chat_service"):
        await run_chat_turn("job-1", "n1", dict(ITEM), [], "why?", "m", None, None, None, client, _FakePublisher(), None)
    assert "Receiver lock time" in client.messages[0]["content"]


def test_the_one_statement_rule_is_for_requirements_only() -> None:
    requirement = _build_system_prompt(ITEM, None, None).lower()
    assert "one requirement statement" in requirement
    for kind in ("Epic", "Feature"):
        other = _build_system_prompt({**ITEM, "type": kind}, None, None).lower()
        assert "one requirement statement" not in other and "shall/should/must" not in other
        assert "keep the title" in other and "number" in other and "invent" in other  # the other rules still apply
