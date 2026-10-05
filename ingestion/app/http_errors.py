from __future__ import annotations

import json
import traceback

import httpx

_BODY_SNIPPET_CHARS = 500


def _response_detail(response: httpx.Response) -> str:
    """The upstream's own explanation: a JSON `message`/`detail` (NestJS and
    FastAPI error shapes) when present, else a truncated raw body. A streamed
    response whose body was never read has no readable text -- returns ''."""
    try:
        text = response.text
    except httpx.ResponseNotRead:
        return ""
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except ValueError:
        return text[:_BODY_SNIPPET_CHARS]
    if isinstance(parsed, dict):
        for key in ("message", "detail"):
            value = parsed.get(key)
            if isinstance(value, str) and value:
                return value
            if isinstance(value, list) and value:
                return "; ".join(str(item) for item in value)
    return text[:_BODY_SNIPPET_CHARS]


def describe_exception(exc: BaseException) -> str:
    """Human-readable one-liner for an exception. For an httpx.HTTPStatusError
    this replaces str(exc) -- which appends a generic "For more information
    check: https://developer.mozilla.org/..." line that explains nothing about
    this failure -- with `<METHOD> <url> returned <status>: <upstream detail>`."""
    if isinstance(exc, httpx.HTTPStatusError):
        request = exc.request
        response = exc.response
        message = f"{request.method} {request.url} returned {response.status_code}"
        detail = _response_detail(response)
        return f"{message}: {detail}" if detail else message
    return str(exc)


def exception_details(exc: BaseException, include_traceback: bool) -> dict:
    """Structured companion to describe_exception for JSON error bodies and
    chat error events. `traceback` is only included when the caller opts in
    (settings.expose_error_details) so internals don't reach every user."""
    details: dict = {}
    if isinstance(exc, httpx.HTTPStatusError):
        details["status"] = exc.response.status_code
        details["url"] = str(exc.request.url)
        details["method"] = exc.request.method
    if include_traceback:
        details["traceback"] = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        )
    return details
