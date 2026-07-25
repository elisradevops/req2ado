from __future__ import annotations

import logging

from starlette.concurrency import run_in_threadpool

from app.chat.chat_client import PROPOSAL_SENTINEL, ChatLlmClient, split_message_and_proposal
from app.chat.redis_publisher import RedisChatPublisher
from app.kb.retrieval import retrieve_context

logger = logging.getLogger(__name__)

_MAX_HISTORY_TURNS = 10


class _SentinelWindow:
    """Buffers streamed text so PROPOSAL_SENTINEL is never split across two
    published chunks, and stops emitting entirely once the sentinel is
    found (everything after it is the structured-proposal JSON, which must
    never reach the live token stream). Holds back the last
    (len(sentinel) - 1) characters of unemitted text until either more text
    proves they weren't the start of the sentinel, or the stream ends."""

    def __init__(self, sentinel: str) -> None:
        self._sentinel = sentinel
        self._buffer = ""
        self._found = False

    def feed(self, delta: str) -> str:
        if self._found:
            return ""
        self._buffer += delta
        sentinel_index = self._buffer.find(self._sentinel)
        if sentinel_index != -1:
            self._found = True
            emit, self._buffer = self._buffer[:sentinel_index], ""
            # The system prompt instructs the model to end its reply with a
            # newline before the sentinel line — that newline is a wire-format
            # separator, not user-visible message content, so trim it before
            # emitting the final pre-sentinel chunk.
            return emit.rstrip("\n")
        hold_back = len(self._sentinel) - 1
        if len(self._buffer) <= hold_back:
            return ""
        emit, self._buffer = self._buffer[:-hold_back], self._buffer[-hold_back:]
        return emit

    def flush(self) -> str:
        if self._found:
            return ""
        emit, self._buffer = self._buffer, ""
        return emit


_SYSTEM_PROMPT_TEMPLATE = (
    "You are refining ONE requirement item in a document review tool. The user "
    "may ask a question or ask you to rewrite the item. Item type: {item_type}. "
    "Item title: {title}. Item description: {description}. {quality_note}"
    "Reply conversationally first. If — and only if — the user asked for a "
    "rewrite of the title and/or description, end your reply with a new line "
    f"containing exactly '{PROPOSAL_SENTINEL}' followed by a single-line JSON "
    'object: {{"proposedTitle": <string or null>, "proposedDescription": '
    '<string or null>}}. If no rewrite was requested, omit the sentinel line '
    "entirely."
)


def _build_system_prompt(item: dict, kb_context: str | None) -> str:
    quality_note = ""
    if item.get("qualityIssues"):
        quality_note = f"Known quality issues: {', '.join(item['qualityIssues'])}. "
    prompt = _SYSTEM_PROMPT_TEMPLATE.format(
        item_type=item.get("childType") or item.get("type") or "Requirement",
        title=item["title"],
        description=item["description"],
        quality_note=quality_note,
    )
    if kb_context:
        prompt = (
            "Reference material from the knowledge base (may be incomplete or "
            f"irrelevant — use only what's genuinely helpful):\n\n{kb_context}\n\n{prompt}"
        )
    return prompt


async def run_chat_turn(
    job_id: str,
    local_id: str,
    item: dict,
    history: list[dict],
    user_message: str,
    model: str | None,
    user_id: str | None,
    embed_client: object | None,
    vector_store: object | None,
    chat_client: ChatLlmClient,
    publisher: RedisChatPublisher,
) -> None:
    """Drives one chat turn end-to-end: retrieves KB context (best-effort),
    builds the prompt, streams the reply, publishes chunks to Redis as they
    arrive, and publishes a final done/error event. Never raises — any
    failure is caught and published as an error event so the WS relay
    (orchestrator) always gets a terminal event for this turn."""
    try:
        kb_context = None
        if user_id is not None and embed_client is not None and vector_store is not None:
            # retrieve_context is a synchronous, blocking call (embed client +
            # vector store I/O) — run in the threadpool so it doesn't stall the
            # single-worker event loop, matching /level and /kb/ingest-* in
            # main.py.
            kb_context, _ = await run_in_threadpool(
                retrieve_context, user_id, user_message, embed_client, vector_store
            )

        system_prompt = _build_system_prompt(item, kb_context)
        capped_history = history[-_MAX_HISTORY_TURNS:]
        messages = (
            [{"role": "system", "content": system_prompt}]
            + capped_history
            + [{"role": "user", "content": user_message}]
        )

        window = _SentinelWindow(PROPOSAL_SENTINEL)
        full_text = ""
        async for delta in chat_client.stream_reply(messages, model):
            if await publisher.is_aborted(job_id, local_id):
                logger.info("Chat turn aborted for job_id=%s local_id=%s", job_id, local_id)
                await publisher.publish_error(job_id, local_id, "stopped by user")
                return
            full_text += delta
            emit = window.feed(delta)
            if emit:
                await publisher.publish_chunk(job_id, local_id, emit)

        trailing = window.flush()
        if trailing:
            await publisher.publish_chunk(job_id, local_id, trailing)

        message, proposed_title, proposed_description = split_message_and_proposal(full_text)
        await publisher.publish_done(
            job_id, local_id, message, proposed_title, proposed_description, model or ""
        )
    except Exception as exc:  # noqa: BLE001 - a chat turn must always terminate with an event
        logger.warning("Chat turn failed for job_id=%s local_id=%s: %s", job_id, local_id, exc)
        await publisher.publish_error(job_id, local_id, str(exc))
