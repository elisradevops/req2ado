from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

_STREAM_REQUEST_TIMEOUT_SECONDS = 120.0
PROPOSAL_SENTINEL = "<<<PROPOSAL>>>"


def split_message_and_proposal(full_text: str) -> tuple[str, str | None, str | None]:
    """Splits a raw model reply into (message, proposedTitle, proposedDescription).
    The model is instructed (see chat_service.py's system prompt) to emit
    PROPOSAL_SENTINEL followed by a single-line JSON object after its
    conversational reply, only when it's actually proposing a change.
    Tolerant: a missing sentinel, malformed JSON, a non-dict JSON value, or a
    non-string field value all fall back to a safe default rather than
    raising — a caller acting on a chat reply is worse off failing the whole
    turn than getting no structured proposal for one malformed response."""
    sentinel_index = full_text.find(PROPOSAL_SENTINEL)
    if sentinel_index == -1:
        return full_text.strip(), None, None

    message = full_text[:sentinel_index].strip()
    raw_json = full_text[sentinel_index + len(PROPOSAL_SENTINEL) :].strip()
    try:
        parsed = json.loads(raw_json)
    except json.JSONDecodeError:
        return message, None, None
    if not isinstance(parsed, dict):
        return message, None, None

    proposed_title = parsed.get("proposedTitle")
    proposed_description = parsed.get("proposedDescription")
    proposed_title = proposed_title if isinstance(proposed_title, str) else None
    proposed_description = proposed_description if isinstance(proposed_description, str) else None
    return message, proposed_title, proposed_description


class ChatLlmClient:
    """Calls orchestrator's POST /llm/chat/stream proxy — NEVER calls Open
    WebUI/Ollama directly, same 'backend proxy, redact-first' boundary
    OrchestratorLlmClient documents. Unlike that class's synchronous
    httpx.Client (a single buffered response), this uses httpx.AsyncClient's
    streaming API since chat needs live token delivery, not one round trip."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.AsyncBaseTransport | None = None  # test-only injection seam

    async def stream_reply(
        self, messages: list[dict], model: str | None, user_id: str | None = None
    ) -> AsyncIterator[tuple[str, str]]:
        """Yields (content_delta, reasoning_delta) pairs -- exactly one of the
        pair is non-empty per chunk (a reasoning model's chain-of-thought
        arrives on a separate wire field, `reasoningDelta`, from the final
        answer's `delta` -- see llm.controller.ts's chatStream doc comment)."""
        # seed=42: same default OrchestratorLlmClient's SURVEY calls already
        # use -- pins the RNG state so an identical (messages, model)
        # request is byte-reproducible for debugging, even though
        # temperature=0.3 (a deliberate non-zero value, unlike every other
        # caller in this codebase) still introduces controlled sampling
        # variety across genuinely different prompts.
        payload: dict = {"messages": messages, "temperature": 0.3, "seed": 42}
        if model is not None:
            payload["model"] = model
        headers = {"Authorization": f"Bearer {self._bearer_token}"}
        # The orchestrator's /llm/* proxy resolves each user's own Open WebUI
        # connection from this header and rejects the call (401) without it --
        # same contract every other ingestion LLM client follows.
        if user_id:
            headers["X-Req2Ado-User-Id"] = user_id
        async with httpx.AsyncClient(transport=self._transport, timeout=_STREAM_REQUEST_TIMEOUT_SECONDS) as client:
            async with client.stream(
                "POST",
                f"{self._base_url}/llm/chat/stream",
                json=payload,
                headers=headers,
            ) as response:
                if response.is_error:
                    # A streamed body must be read before describe_exception
                    # can surface the orchestrator's own error message.
                    await response.aread()
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    delta = chunk.get("delta", "")
                    reasoning_delta = chunk.get("reasoningDelta", "")
                    if delta or reasoning_delta:
                        yield delta, reasoning_delta
