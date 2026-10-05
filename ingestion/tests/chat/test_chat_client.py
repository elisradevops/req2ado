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

    chunks = [chunk async for chunk in client.stream_reply([{"role": "user", "content": "hi"}], model="llama3.1")]

    assert chunks == [("Hel", ""), ("lo", "")]


@pytest.mark.asyncio
async def test_stream_reply_yields_reasoning_deltas_separately_from_content() -> None:
    # A reasoning model's chain-of-thought arrives on its own wire field
    # (reasoningDelta) from orchestrator's llm.controller.ts -- confirmed
    # each chunk carries at most one of the two.
    def handler(request: httpx.Request) -> httpx.Response:
        body = b'{"reasoningDelta": "Hmm, "}\n{"reasoningDelta": "let me think."}\n{"delta": "Sure."}\n'
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = transport  # noqa: SLF001

    chunks = [chunk async for chunk in client.stream_reply([{"role": "user", "content": "hi"}], model="llama3.1")]

    assert chunks == [("", "Hmm, "), ("", "let me think."), ("Sure.", "")]


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


async def test_stream_reply_sends_a_fixed_seed_for_reproducibility() -> None:
    # Real gap this closes: this was the one non-JSON chat surface with a
    # non-zero temperature and no seed at all -- an identical request
    # couldn't be reproduced for debugging. Same seed=42 default
    # OrchestratorLlmClient's SURVEY calls already use.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"")

    transport = httpx.MockTransport(handler)
    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = transport  # noqa: SLF001

    [_ async for _ in client.stream_reply([{"role": "user", "content": "hi"}], model=None)]

    assert captured["body"]["seed"] == 42
    assert captured["body"]["temperature"] == 0.3


@pytest.mark.asyncio
async def test_stream_reply_sends_user_id_header_when_given() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = request.headers
        return httpx.Response(200, content=b"")

    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = httpx.MockTransport(handler)  # noqa: SLF001

    [_ async for _ in client.stream_reply([{"role": "user", "content": "hi"}], model=None, user_id="user-1")]

    assert captured["headers"]["x-req2ado-user-id"] == "user-1"


@pytest.mark.asyncio
async def test_stream_reply_error_carries_orchestrator_message_without_mdn_suffix() -> None:
    from app.http_errors import describe_exception

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"statusCode": 401, "message": "X-Req2Ado-User-Id header is required"})

    client = ChatLlmClient("http://orchestrator:3001", "test-token")
    client._transport = httpx.MockTransport(handler)  # noqa: SLF001

    with pytest.raises(httpx.HTTPStatusError) as caught:
        [_ async for _ in client.stream_reply([{"role": "user", "content": "hi"}], model=None)]

    described = describe_exception(caught.value)
    assert "401" in described
    assert "/llm/chat/stream" in described
    assert "X-Req2Ado-User-Id header is required" in described
    assert "mozilla" not in described
