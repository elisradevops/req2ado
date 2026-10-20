from __future__ import annotations

import logging

from starlette.concurrency import run_in_threadpool

from app.chat.chat_client import PROPOSAL_SENTINEL, ChatLlmClient, split_message_and_proposal
from app.chat.context_pack import render_context_pack
from app.chat.redis_publisher import RedisChatPublisher
from app.config import settings
from app.http_errors import describe_exception, exception_details
from app.kb.profile import render_authoring_standard
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
    "{rewrite_rules}"
    "Reply conversationally first. If — and only if — the user asked for a "
    "rewrite of the title and/or description, end your reply with a new line "
    f"containing exactly '{PROPOSAL_SENTINEL}' followed by a single-line JSON "
    'object: {{"proposedTitle": <string or null>, "proposedDescription": '
    '<string or null>}}. If no rewrite was requested, omit the sentinel line '
    "entirely."
)


_REWRITE_RULES = (
    "Rules for any rewrite: {shape}"
    "keep the title unless the user asked to change it; keep every number, unit, identifier "
    "and named entity of the current description; do not make it longer than about two times "
    "the length of the current description unless the user asked for more; use the "
    "organization's definitions, rules and terms given above and stay consistent with the document context. "
    "Do not invent facts: if an improvement needs information that is neither in the item nor in "
    "the material above (a value, a unit, an actor, a condition), ask the user for it instead of "
    "proposing a rewrite. "
)
_SHAPE_REQUIREMENT = "keep it ONE requirement statement (one shall/should/must); "
_SHAPE_OTHER = "keep it a concise description of the scope of the {kind}, not a requirement statement; "


_WEAK_CATEGORY_SCORE = 70
_WEAKEST_SHOWN = 2


def _weakest_categories(scores: dict | None) -> list[tuple[str, float]]:
    """The item's weakest quality categories: score below the bar, at most _WEAKEST_SHOWN, weakest first."""
    if not isinstance(scores, dict):
        return []
    usable = sorted(
        ((name, float(value)) for name, value in scores.items() if isinstance(name, str) and isinstance(value, (int, float)) and not isinstance(value, bool)),
        key=lambda pair: (pair[1], pair[0]),
    )
    return [(name, value) for name, value in usable if value < _WEAK_CATEGORY_SCORE][:_WEAKEST_SHOWN]


def weakest_category_note(scores: dict | None, profile) -> str | None:
    """A note for the chat prompt naming the item's weakest quality categories (score below 70, at most two, weakest first)
    with the organization's pass condition from its KB profile when it has one, so a rewrite is aimed at what actually
    lowers the item's score. None when there are no usable scores or every category is good."""
    weak = _weakest_categories(scores)
    if not weak:
        return None
    conditions = {c.name.casefold(): c.pass_condition for c in (profile.categories if profile else []) if c.pass_condition}
    parts = []
    for name, value in weak:
        condition = conditions.get(name.casefold())
        parts.append(f"{name} ({value:g})" + (f", whose pass condition is: {condition}" if condition else ""))
    return (
        "The item's weakest quality categories are " + "; ".join(parts) + ". When the user asks for a rewrite, aim it at "
        "improving the weakest category first without losing what the item already does well, and say which category the "
        "rewrite targets. "
    )


def _build_system_prompt(
    item: dict, kb_context: str | None, weakest_note: str | None = None, context: dict | None = None, standard: str | None = None,
) -> str:
    """The organization's standard first (what an Epic, Feature and Requirement are, its rules, terms and every category's pass
    condition), then reference chunks from the knowledge base, then where the item sits in the document, then the item."""
    quality_note = ""
    if item.get("qualityIssues"):
        quality_note = f"Known quality issues: {', '.join(item['qualityIssues'])}. "
    if weakest_note:
        quality_note += weakest_note
    item_type = item.get("childType") or item.get("type") or "Requirement"
    shape = _SHAPE_REQUIREMENT if item_type == "Requirement" else _SHAPE_OTHER.format(kind=item_type)
    prompt = _SYSTEM_PROMPT_TEMPLATE.format(
        rewrite_rules=_REWRITE_RULES.format(shape=shape),
        item_type=item_type,
        title=item["title"],
        description=item["description"],
        quality_note=quality_note,
    )
    sections: list[str] = []
    if standard:
        sections.append(f"The organization's own standard for requirements (authoritative; follow it):\n\n{standard}")
    if kb_context:
        sections.append(
            "Reference material from the knowledge base (may be incomplete or irrelevant — use only what's genuinely "
            f"helpful):\n\n{kb_context}"
        )
    pack = render_context_pack(context)
    if pack:
        sections.append(pack)
    return "\n\n".join([*sections, prompt])


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
    profile: object | None = None,
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
            # Retrieved by what the item says (and what was asked): "improve this" alone retrieves near-random chunks.
            retrieval_query = "\n".join(part for part in (item.get("title"), item.get("description"), user_message) if part)
            kb_context, _ = await run_in_threadpool(
                retrieve_context, user_id, retrieval_query, embed_client, vector_store
            )

        weakest = _weakest_categories(item.get("qualityCategoryScores"))
        # Category names and scores only, never the item's or the user's text: shows which category a turn aimed at.
        logger.info(
            "chat turn: job=%s node=%s weakest=%s profile=%s", job_id, local_id,
            ", ".join(f"{name}={value:g}" for name, value in weakest) or "none", "yes" if profile is not None else "no",
        )
        system_prompt = _build_system_prompt(
            item, kb_context, weakest_category_note(item.get("qualityCategoryScores"), profile),
            context=item.get("context"), standard=render_authoring_standard(profile),
        )
        capped_history = history[-_MAX_HISTORY_TURNS:]
        messages = (
            [{"role": "system", "content": system_prompt}]
            + capped_history
            + [{"role": "user", "content": user_message}]
        )

        window = _SentinelWindow(PROPOSAL_SENTINEL)
        full_text = ""
        async for delta, reasoning_delta in chat_client.stream_reply(messages, model, user_id):
            if await publisher.is_aborted(job_id, local_id):
                logger.info("Chat turn aborted for job_id=%s local_id=%s", job_id, local_id)
                await publisher.publish_error(job_id, local_id, "stopped by user")
                return
            # Reasoning tokens bypass the sentinel window entirely -- the
            # window only guards the FINAL answer against PROPOSAL_SENTINEL
            # leaking into the visible content stream; a model's
            # chain-of-thought is never persisted or scanned for it, so
            # there is nothing here to buffer against.
            if reasoning_delta:
                await publisher.publish_reasoning_chunk(job_id, local_id, reasoning_delta)
            if delta:
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
        reason = describe_exception(exc)
        logger.warning("Chat turn failed for job_id=%s local_id=%s: %s", job_id, local_id, reason)
        await publisher.publish_error(
            job_id, local_id, reason, exception_details(exc, settings.expose_error_details)
        )
