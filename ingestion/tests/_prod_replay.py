"""Production model behaviours, replayed offline (docs/prod-eval-baseline-2026-11-22.md).

Dev runs only a local model, so what the production families did on the 2026-11-22 baseline is kept here as data and served by a
fake orchestrator (`/llm/chat`) through `httpx.MockTransport`. A test states which behaviour it replays; a new finding is one more
entry, not a new stub.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx

from app.prompts.assembly import block_text

# GPT answers Hebrew rows in English: a well-formed answer for every requested id that the language check refuses (the eval's
# `every_row: missing ['x1', 'x2']` on synthesize_leaf_requirements/hebrew_rows and title_and_tags_for_rows/hebrew_rows).
GPT_ENGLISH_TITLES = {"x1": "Input voltage", "x2": "Boot time"}
HEBREW_TITLES = {"x1": "מתח כניסה", "x2": "זמן אתחול"}
HEBREW_ROWS = {"x1": "מתח כניסה: 28 וולט", "x2": "זמן אתחול: 2 שניות"}


# The provider's content filter blocks knowledge-base text that reads like an injection (the eval's kb_injection fixture, every GPT
# model: `ContentPolicyViolationError`, 400). The orchestrator answers it as a final 422 carrying its code (F2), in the body shape of
# its HTTP errors. The class name is from the baseline; the provider's tail is not a verbatim capture.
CONTENT_FILTER_MESSAGE = (
    "LLM_CONTENT_FILTERED: litellm.ContentPolicyViolationError: The response was filtered due to the prompt "
    "triggering the content management policy."
)


def content_filter_block(_request: httpx.Request | None = None) -> httpx.Response:
    return httpx.Response(422, json={"statusCode": 422, "message": CONTENT_FILTER_MESSAGE})


def carries_kb(request: httpx.Request) -> bool:
    """Whether a call sent knowledge-base text (a `reference` or `rubric` block)."""
    user = json.loads(request.content)["messages"][1]["content"]
    return block_text(user, "reference") is not None or block_text(user, "rubric") is not None


def asked_ids(request: httpx.Request) -> list[str]:
    """The ids a keyed call asked about (its source block)."""
    body = json.loads(request.content)
    return list(json.loads(block_text(body["messages"][1]["content"])))


def keyed_answer(entries: dict[str, dict], routed_to: str | None = None) -> httpx.Response:
    """A well-formed array-format answer, as the orchestrator relays it. `routed_to`: the gateway's `Auto` router sent the call to this
    model, and the answer's headers said so (the orchestrator passes it on as `routing`; without the headers there is none)."""
    items = [{"id": node_id, **entry} for node_id, entry in entries.items()]
    return answer(json.dumps({"items": items}, ensure_ascii=False), routed_to)


# The gateway's `Auto` is a complexity router (docs/prod-eval-baseline-2026-11-22.md, F7): SIMPLE goes to gpt-5-mini, MEDIUM (and the
# fallback) to gpt-5.4, COMPLEX/REASONING to claude-opus-5-5. The tier is what the router's header says.
ROUTER_TIERS = {"OpenAI/gpt-5-mini": "SIMPLE", "OpenAI/gpt-5.4": "MEDIUM", "claude-opus-5-5": "COMPLEX"}


def answer(content: str, routed_to: str | None = None) -> httpx.Response:
    """Any /llm/chat answer, optionally naming the model a router sent the call to."""
    routing = {"routing": {"model": routed_to, "tier": ROUTER_TIERS.get(routed_to, "MEDIUM")}} if routed_to else {}
    return httpx.Response(200, json={"content": content, **routing})


def replay(*answers: Callable[[httpx.Request], httpx.Response]) -> tuple[Callable[[httpx.Request], httpx.Response], list[dict]]:
    """A handler that answers the n-th request with the n-th answer, recording every request body."""
    bodies: list[dict] = []
    queue = list(answers)

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return queue.pop(0)(request)

    return handler, bodies
