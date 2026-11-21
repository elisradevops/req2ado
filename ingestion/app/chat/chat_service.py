from __future__ import annotations

import logging

from starlette.concurrency import run_in_threadpool

from app.chat.chat_client import (
    PROPOSAL_SENTINEL,
    ChatLlmClient,
    proposal_failure_reason,
    split_message_and_proposal,
)
from app.chat.context_pack import render_context_pack
from app.chat.redis_publisher import RedisChatPublisher
from app.config import settings
from app.http_errors import describe_exception, exception_details
from app.kb.profile import render_authoring_standard
from app.kb.retrieval import retrieve_context
from app.language_policy import dominant_script, script_name
from app.leveling.description_text import (
    description_for_model,
    markers_as_words,
    restore_tables,
    split_tables,
    table_context,
)
from app.prompts.assembly import DataBlock, Fragment, PromptCall, build_call

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


# Mirrored in frontend/src/utils/qualityCategories.ts (WEAK_CATEGORY_SCORE); a frontend test fails if the two differ.
_WEAK_CATEGORY_SCORE = 70
_WEAKEST_SHOWN = 2


def _weakest_categories(scores: dict | None) -> list[tuple[str, float]]:
    """The item's weakest quality categories: score below the bar, at most _WEAKEST_SHOWN, weakest first."""
    if not isinstance(scores, dict):
        return []
    usable = sorted(
        (
            (name, float(value))
            for name, value in scores.items()
            if isinstance(name, str)
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
        ),
        key=lambda pair: (pair[1], pair[0]),
    )
    return [(name, value) for name, value in usable if value < _WEAK_CATEGORY_SCORE][
        :_WEAKEST_SHOWN
    ]


def weakest_category_note(scores: dict | None, profile) -> str | None:
    """The item's weakest quality categories (score below 70, at most two, weakest first), each with the organization's pass condition
    from its KB profile when it has one, so a rewrite is aimed at what actually lowers the item's score. Data for the chat's
    <weakest_categories> block (the pass conditions are knowledge-base text). None when there are no usable scores or every
    category is good."""
    weak = _weakest_categories(scores)
    if not weak:
        return None
    conditions = {
        c.name.casefold(): c.pass_condition
        for c in (profile.categories if profile else [])
        if c.pass_condition
    }
    parts = []
    for name, value in weak:
        condition = conditions.get(name.casefold())
        parts.append(
            f"{name} ({value:g})" + (f", whose pass condition is: {condition}" if condition else "")
        )
    return "\n".join(parts)


def _build_call(
    item: dict,
    kb_context: str | None,
    weakest_note: str | None = None,
    context: dict | None = None,
    standard: str | None = None,
    tables: list[str] | None = None,
    history: list[dict] | None = None,
    user_message: str | None = None,
    obligation_forms: list[str] | None = None,
) -> PromptCall:
    """The chat turn's call: the instructions in the system prompt; the organization's standard (what an Epic, Feature and Requirement are,
    its rules, terms and every category's pass condition), the knowledge-base chunks, where the item sits in the document, the item
    itself, its tables and its weakest categories as data blocks in this turn's user message, followed by what the user wrote. The
    output-language policy (app.language_policy) follows the item's own script, and a Requirement's obligation form is the organization's
    (`obligation_forms`, from its profile), carried as standard data."""
    issues = item.get("qualityIssues")
    item_type = item.get("childType") or item.get("type") or "Requirement"
    # A Requirement stays one statement; an Epic or Feature stays a description of its scope.
    shape = (
        Fragment("fragment_chat_shape_requirement")
        if item_type == "Requirement"
        else Fragment("fragment_chat_shape_other", {"kind": item_type})
    )
    pack = render_context_pack(context)
    item_text = f"Title: {item['title']}\nDescription: {item['description']}"
    script = dominant_script(item_text)
    language = (
        Fragment("fragment_output_language", {"script": script_name(script)})
        if script
        else Fragment("fragment_output_language_unknown")
    )
    forms = obligation_forms if item_type == "Requirement" else None
    after = [
        language,
        *(
            [Fragment("fragment_obligation_form", {"forms_from": "the organization's standard"})]
            if forms
            else []
        ),
    ]
    blocks = [
        *([DataBlock("org_standard", standard)] if standard else []),
        *([DataBlock("org_standard", "\n".join(forms), tag="obligation_forms")] if forms else []),
        *([DataBlock("reference", kb_context)] if kb_context else []),
        *([DataBlock("background", pack)] if pack else []),
        DataBlock("source", item_text, tag="item"),
        *([DataBlock("source", table_context(tables), tag="item_tables")] if tables else []),
        *([DataBlock("reference", weakest_note, tag="weakest_categories")] if weakest_note else []),
    ]
    return build_call(
        "chat_refine_item",
        markers={
            "item_type": item_type,
            "quality_note": Fragment("fragment_chat_quality_issues", {"issues": ", ".join(issues)})
            if issues
            else "",
            "weakest_note": Fragment("fragment_chat_weakest_categories") if weakest_note else "",
            "table_note": Fragment("fragment_chat_table_note") if tables else "",
            "rewrite_rules": Fragment("fragment_chat_rewrite_rules", {"shape": shape}),
            "proposal_sentinel": PROPOSAL_SENTINEL,
        },
        blocks=blocks,
        after=after,
        history=history or [],
        user_text=user_message,
    )


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
        # The model reads each table as read-only CSV behind a marker and never writes one; the stored tables are put back below.
        tables: list[str] = []
        retrieval_description = description_for_model(item.get("description"))
        if settings.chat_table_placeholders_enabled:
            marked_description, tables = split_tables(item.get("description"))
            if tables:
                item = {**item, "description": marked_description}
        kb_context = None
        if user_id is not None and embed_client is not None and vector_store is not None:
            # retrieve_context is a synchronous, blocking call (embed client +
            # vector store I/O) — run in the threadpool so it doesn't stall the
            # single-worker event loop, matching /level and /kb/ingest-* in
            # main.py.
            # Retrieved by what the item says (and what was asked): "improve this" alone retrieves near-random chunks.
            retrieval_query = "\n".join(
                part for part in (item.get("title"), retrieval_description, user_message) if part
            )
            kb_context, _ = await run_in_threadpool(
                retrieve_context, user_id, retrieval_query, embed_client, vector_store
            )

        weakest = _weakest_categories(item.get("qualityCategoryScores"))
        # Category names and scores only, never the item's or the user's text: shows which category a turn aimed at.
        logger.info(
            "chat turn: job=%s node=%s weakest=%s profile=%s",
            job_id,
            local_id,
            ", ".join(f"{name}={value:g}" for name, value in weakest) or "none",
            "yes" if profile is not None else "no",
        )
        call = _build_call(
            item,
            kb_context,
            weakest_category_note(item.get("qualityCategoryScores"), profile),
            context=item.get("context"),
            standard=render_authoring_standard(profile),
            tables=tables,
            obligation_forms=[f.text for f in profile.obligation_forms]
            if profile is not None and getattr(profile, "source", "kb") != "default"
            else None,
            history=history[-_MAX_HISTORY_TURNS:],
            user_message=user_message,
        )

        window = _SentinelWindow(PROPOSAL_SENTINEL)
        full_text = ""
        async for delta, reasoning_delta in chat_client.stream_reply(call, model, user_id):
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
        if tables:
            message = markers_as_words(message)
            if proposed_description is not None:
                proposed_description, table_counts = restore_tables(proposed_description, tables)
                logger.info(
                    "chat tables: job=%s node=%s tables=%d restored=%d reattached=%d dropped_extra=%d csv_rows_removed=%d",
                    job_id,
                    local_id,
                    len(tables),
                    table_counts["restored"],
                    table_counts["reattached"],
                    table_counts["dropped_extra"],
                    table_counts["csv_rows_removed"],
                )
        # Why a turn has no proposal, with no text: a reply that announces a rewrite ("...rewrite:") and delivers none looks the same to the
        # user whether the model wrote no marker or an unreadable one.
        reason = proposal_failure_reason(full_text)
        last_line = message.strip().splitlines()[-1].strip() if message.strip() else ""
        logger.info(
            "chat turn result: job=%s node=%s %s",
            job_id,
            local_id,
            "proposal=yes"
            if reason is None
            else f"proposal=none reason={reason} announced={'yes' if reason == 'no_marker' and last_line.endswith(':') else 'no'}",
        )
        await publisher.publish_done(
            job_id, local_id, message, proposed_title, proposed_description, model or ""
        )
    except Exception as exc:  # noqa: BLE001 - a chat turn must always terminate with an event
        reason = describe_exception(exc)
        logger.warning("Chat turn failed for job_id=%s local_id=%s: %s", job_id, local_id, reason)
        await publisher.publish_error(
            job_id, local_id, reason, exception_details(exc, settings.expose_error_details)
        )
