import json

import httpx
import pytest

from app.chat.chat_client import ChatLlmClient, PROPOSAL_SENTINEL, split_message_and_proposal


def test_no_sentinel_returns_full_text_as_message() -> None:
    message, title, description = split_message_and_proposal("Sure, here's why that's ambiguous.")
    assert message == "Sure, here's why that's ambiguous."
    assert title is None
    assert description is None


def test_sentinel_with_valid_json_extracts_proposal() -> None:
    text = (
        "Here's a tighter version.\n"
        f"{PROPOSAL_SENTINEL}\n"
        '{"proposedTitle": "New title", "proposedDescription": "New description"}'
    )
    message, title, description = split_message_and_proposal(text)
    assert message == "Here's a tighter version."
    assert title == "New title"
    assert description == "New description"


def test_sentinel_with_null_fields_returns_none() -> None:
    text = f"Just answering your question.\n{PROPOSAL_SENTINEL}\n" '{"proposedTitle": null, "proposedDescription": null}'
    message, title, description = split_message_and_proposal(text)
    assert message == "Just answering your question."
    assert title is None
    assert description is None


def test_sentinel_with_malformed_json_falls_back_to_message_only() -> None:
    text = f"Some reply.\n{PROPOSAL_SENTINEL}\nnot valid json"
    message, title, description = split_message_and_proposal(text)
    assert message == "Some reply."
    assert title is None
    assert description is None


def test_sentinel_with_non_dict_json_falls_back_to_message_only() -> None:
    text = f"Some reply.\n{PROPOSAL_SENTINEL}\n[1, 2, 3]"
    message, title, description = split_message_and_proposal(text)
    assert message == "Some reply."
    assert title is None
    assert description is None


def test_sentinel_with_non_string_field_values_treated_as_none() -> None:
    text = f"Some reply.\n{PROPOSAL_SENTINEL}\n" '{"proposedTitle": 42, "proposedDescription": "ok"}'
    message, title, description = split_message_and_proposal(text)
    assert title is None
    assert description == "ok"


@pytest.mark.asyncio
async def test_stream_reply_yields_deltas_from_ndjson_lines() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-token"
        body = b'{"delta": "Hel"}\n{"delta": "lo"}\n'
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = transport  # noqa: SLF001 - test injection seam

    deltas = [delta async for delta in client.stream_reply([{"role": "user", "content": "hi"}], model="llama3.1")]

    assert deltas == ["Hel", "lo"]


@pytest.mark.asyncio
async def test_stream_reply_omits_model_key_when_none() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"")

    transport = httpx.MockTransport(handler)
    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = transport  # noqa: SLF001

    [_ async for _ in client.stream_reply([{"role": "user", "content": "hi"}], model=None)]

    assert "model" not in captured["body"]
