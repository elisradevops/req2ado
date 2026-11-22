"""A provider's content filter blocking a model call (production finding F1).

The orchestrator answers such a block as a final 422 carrying CONTENT_FILTERED_CODE: it never repeats the call, because the same text
is blocked again. In production the GPT family's filter blocked knowledge-base text that reads like an injection, so a pass that sent
a KB block asks once more without it rather than lose the call, and says so in a job warning naming the pass."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TypeVar

import httpx

from app.workitem.model import IntegrityWarning, WarningKind

logger = logging.getLogger(__name__)

CONTENT_FILTERED_CODE = "LLM_CONTENT_FILTERED"

_T = TypeVar("_T")


def is_content_filtered(error: BaseException) -> bool:
    """Whether `error` is the orchestrator's answer to a provider content-filter block."""
    return (
        isinstance(error, httpx.HTTPStatusError)
        and error.response.status_code == 422
        and CONTENT_FILTERED_CODE in error.response.text
    )


def without_kb_when_blocked(
    call: Callable[[str | None], _T], kb_context: str | None, label: str
) -> tuple[_T, bool]:
    """`call(kb_context)`, and whether the KB text was left out: when the provider's filter blocked a call that carried KB text, it is
    asked once more without it. A block without KB text (the document's own) and every other failure are raised unchanged."""
    try:
        return call(kb_context), False
    except httpx.HTTPStatusError as error:
        if kb_context is None or not is_content_filtered(error):
            raise
    logger.warning(
        "%s: the provider's content filter blocked the call; asking once more without the knowledge-base text",
        label,
    )
    return call(None), True


def kb_blocked_warning(pass_name: str, step: str, node_ids: list[str]) -> IntegrityWarning:
    """The job warning for the items a pass handled without its KB text. `step` names the pass in the message ("quality scoring")."""
    return IntegrityWarning.make(
        WarningKind.KB_CONTEXT_BLOCKED,
        f"The model provider's content filter blocked the knowledge-base text sent with {step} for {len(node_ids)} item(s), "
        "so that step ran without it for them.",
        node_ids=node_ids,
        detail={"pass": pass_name},
    )
