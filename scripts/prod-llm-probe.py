#!/usr/bin/env python3
"""Production LLM probe: what the proxy and each model really do, measured with SYNTHETIC text (and one figure only if you pass one).

Complements scripts/model-compat-probe.py. That one runs inside the ingestion pod through the orchestrator's /llm routes and checks what
each model ACCEPTS. This one talks to the proxy (Open WebUI in front of LiteLLM) directly, so it can read the token usage the orchestrator
hides, and measures what the app's limits and budgets depend on:

  * the output-limit parameter each model takes (max_tokens, max_completion_tokens, or neither);
  * what the model states about itself in the listing (max output tokens, context length), when it states anything;
  * how many tokens a reasoning model spends THINKING before it answers at a small limit (finish_reason "length" with empty content);
  * whether reasoning_effort is accepted at all;
  * Hebrew: characters per prompt token (the app's chars/4 estimate is wrong for Hebrew);
  * rate limits: the statuses and slowest time for 1, 2, 4 ... parallel calls;
  * with --image: the verdict, output size and time of a figure description with the app's structured-output schema.

It needs only the Python standard library. Run it on a machine that can reach the proxy:

    PROBE_BASE_URL=https://<open-webui-host> PROBE_API_KEY=<key> python scripts/prod-llm-probe.py \\
        --models claude-opus-4-8,gpt-5.5,gpt-oss-120b --image figure.png --json-out probe.json

It never prints the key or any model output text: only statuses, token counts, sizes, times and the proxy's own short error messages.
Send probe.json back so the capability table (orchestrator/src/modules/llm/model-capabilities.ts) and the output budgets can be set from facts.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request

CHAT_PATH = "/api/chat/completions"
MODELS_PATHS = ("/api/models", "/v1/models")
THINKING_PROMPT = "How many times does the letter r appear in the word strawberry? Work it out carefully, step by step, then answer with the number."
ENGLISH = "The receiver shall tune across the 2 to 18 GHz band in 1 MHz steps, settling within 50 microseconds of a commanded change. " * 6
HEBREW = "המקלט יכוונן לאורך הפס מ-2 עד 18 גיגה-הרץ בצעדים של 1 מגה-הרץ, ויתייצב תוך 50 מיקרו-שניות מרגע הפקודה לשינוי. " * 6
FIGURE_SCHEMA = {
    "name": "figure_significance",
    "schema": {
        "type": "object",
        "properties": {
            "significant": {"type": "boolean", "description": "True if the figure has real technical or informational content, including a table, chart or screenshot of values."},
            "description": {"type": "string", "description": "2-4 plain sentences describing this figure. Empty if not significant."},
            "title": {"type": "string", "description": "A short noun-phrase title."},
        },
        "required": ["significant", "description"],
    },
}
FIGURE_PROMPT = "Describe this figure in 2-4 sentences of plain prose and judge whether it has genuine informational content. Also give a short title."


def _request(method: str, url: str, key: str, body: dict | None = None, timeout: float = 240.0) -> tuple[int, object, float]:
    """(status, parsed JSON or short text, seconds). A network failure is status 0."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        status = error.code
    except Exception as error:  # noqa: BLE001 -- a probe reports a network failure, it does not crash on it
        return 0, type(error).__name__, time.monotonic() - started
    seconds = time.monotonic() - started
    try:
        return status, json.loads(raw), seconds
    except ValueError:
        return status, " ".join(raw.split())[:200], seconds


def _error_text(payload: object) -> str:
    """The proxy's own short error message (never the request)."""
    if isinstance(payload, dict):
        error = payload.get("error")
        message = error.get("message") if isinstance(error, dict) else error
        return " ".join(str(message or payload.get("detail") or "").split())[:200]
    return " ".join(str(payload).split())[:200]


def _usage(payload: object) -> dict:
    usage = payload.get("usage", {}) if isinstance(payload, dict) else {}
    details = usage.get("completion_tokens_details") or {}
    return {"prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"), "reasoning_tokens": details.get("reasoning_tokens")}


def _choice(payload: object) -> tuple[str, str]:
    if isinstance(payload, dict) and payload.get("choices"):
        choice = payload["choices"][0]
        return str(choice.get("finish_reason")), str((choice.get("message") or {}).get("content") or "")
    return "none", ""


def _listing(base: str, key: str, model: str) -> dict | None:
    """What the listing states about the model's limits, or None when it states nothing (several prod models do not)."""
    for path in MODELS_PATHS:
        status, payload, _ = _request("GET", base + path, key, timeout=60)
        if status != 200 or not isinstance(payload, dict):
            continue
        for entry in payload.get("data", []):
            if entry.get("id") != model:
                continue
            found: dict = {}

            def walk(node: object) -> None:
                if isinstance(node, dict):
                    for name, value in node.items():
                        if isinstance(value, (int, float)) and any(word in name.lower() for word in ("max_output", "max_completion", "context_length", "context_window", "max_input")):
                            found[name] = value
                        else:
                            walk(value)
                elif isinstance(node, list):
                    for item in node:
                        walk(item)

            walk(entry)
            return found or None
    return None


def _chat(base: str, key: str, model: str, messages: list, limit_param: str | None, limit: int | None, **extra: object) -> tuple[int, object, float]:
    body: dict = {"model": model, "messages": messages, **extra}
    if limit_param and limit is not None:
        body[limit_param] = limit
    return _request("POST", base + CHAT_PATH, key, body)


def _token_param(base: str, key: str, model: str) -> str | None:
    """The output-limit parameter the model takes: tried in turn; None when both are refused (no limit can be sent)."""
    for param in ("max_tokens", "max_completion_tokens"):
        status, _, _ = _chat(base, key, model, [{"role": "user", "content": "Reply with the word ok."}], param, 200)
        if status == 200:
            return param
    return None


def _shape(status: int, payload: object, seconds: float) -> dict:
    finish, content = _choice(payload)
    return {"status": status, "finish_reason": finish, "content_chars": len(content), "seconds": round(seconds, 1), **_usage(payload), **({"error": _error_text(payload)} if status != 200 else {})}


def _parallel(base: str, key: str, model: str, param: str | None, count: int) -> dict:
    def one(_: int) -> tuple[int, float]:
        status, _payload, seconds = _chat(base, key, model, [{"role": "user", "content": "Reply with the word ok."}], param, 50)
        return status, seconds

    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        results = list(pool.map(one, range(count)))
    return {"statuses": sorted(status for status, _ in results), "slowest_seconds": round(max(seconds for _, seconds in results), 1)}


def _vision(base: str, key: str, model: str, param: str | None, image_path: str) -> dict:
    with open(image_path, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")
    mime = mimetypes.guess_type(image_path)[0] or "image/png"
    messages = [{"role": "user", "content": [{"type": "text", "text": FIGURE_PROMPT}, {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}}]}]
    status, payload, seconds = _chat(base, key, model, messages, param, 4000, response_format={"type": "json_schema", "json_schema": {**FIGURE_SCHEMA, "strict": False}})
    shaped = _shape(status, payload, seconds)
    _, content = _choice(payload)
    try:
        verdict = json.loads(content).get("significant")
    except (ValueError, AttributeError):
        verdict = None
    return {**shaped, "significant": verdict, "image_bytes": len(encoded) * 3 // 4}


def probe_model(base: str, key: str, model: str, image_path: str | None, parallel: tuple[int, ...]) -> dict:
    param = _token_param(base, key, model)
    result: dict = {"listing": _listing(base, key, model), "token_param": param or "none"}
    thinking = [{"role": "user", "content": THINKING_PROMPT}]
    result["small_limit"] = _shape(*_chat(base, key, model, thinking, param, 400)) if param else None
    result["larger_limit"] = _shape(*_chat(base, key, model, thinking, param, 4000)) if param else _shape(*_chat(base, key, model, thinking, None, None))
    status, _, _ = _chat(base, key, model, [{"role": "user", "content": "Reply with the word ok."}], param, 200, reasoning_effort="low")
    result["reasoning_effort_accepted"] = status == 200
    status, payload, _ = _chat(base, key, model, [{"role": "user", "content": HEBREW}], param, 200)
    tokens = _usage(payload).get("prompt_tokens")
    english_status, english_payload, _ = _chat(base, key, model, [{"role": "user", "content": ENGLISH}], param, 200)
    english_tokens = _usage(english_payload).get("prompt_tokens")
    result["hebrew"] = {"chars": len(HEBREW), "prompt_tokens": tokens, "chars_per_token": round(len(HEBREW) / tokens, 2) if tokens and status == 200 else None}
    result["english"] = {"chars": len(ENGLISH), "prompt_tokens": english_tokens, "chars_per_token": round(len(ENGLISH) / english_tokens, 2) if english_tokens and english_status == 200 else None}
    result["parallel"] = {str(count): _parallel(base, key, model, param, count) for count in parallel}
    if image_path:
        result["vision"] = _vision(base, key, model, param, image_path)
    return result


def run(base: str, key: str, models: list[str], image_path: str | None = None, parallel: tuple[int, ...] = (1, 2, 4)) -> dict:
    base = base.rstrip("/")
    return {"base": "(not recorded)", "models": {model: probe_model(base, key, model, image_path, parallel) for model in models}}


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure what the proxy and each model really do (synthetic text only).")
    parser.add_argument("--models", required=True, help="comma-separated model ids as the proxy lists them")
    parser.add_argument("--image", help="optional figure to describe (PNG/JPEG): the only non-synthetic input")
    parser.add_argument("--parallel", default="1,2,4", help="parallel call counts to try for rate limits")
    parser.add_argument("--json-out", help="write the full report here")
    args = parser.parse_args()
    base, key = os.environ.get("PROBE_BASE_URL"), os.environ.get("PROBE_API_KEY")
    if not base or not key:
        print("Set PROBE_BASE_URL and PROBE_API_KEY.", file=sys.stderr)
        return 2
    report = run(base, key, [m.strip() for m in args.models.split(",") if m.strip()], args.image, tuple(int(n) for n in args.parallel.split(",")))
    for model, result in report["models"].items():
        print(f"== {model}")
        print(f"   output-limit parameter: {result['token_param']}; listing states: {result['listing'] or 'nothing'}")
        small = result["small_limit"]
        if small:
            print(f"   at a limit of 400: finish={small['finish_reason']} content_chars={small['content_chars']} completion_tokens={small['completion_tokens']} reasoning_tokens={small['reasoning_tokens']}")
        larger = result["larger_limit"]
        print(f"   at a limit of 4000: finish={larger['finish_reason']} content_chars={larger['content_chars']} completion_tokens={larger['completion_tokens']} reasoning_tokens={larger['reasoning_tokens']} {larger['seconds']}s")
        print(f"   reasoning_effort accepted: {result['reasoning_effort_accepted']}; characters per token: Hebrew {result['hebrew']['chars_per_token']}, English {result['english']['chars_per_token']}")
        for count, outcome in result["parallel"].items():
            print(f"   {count} parallel: statuses {outcome['statuses']} slowest {outcome['slowest_seconds']}s")
        if "vision" in result:
            v = result["vision"]
            print(f"   figure: status={v['status']} significant={v['significant']} finish={v['finish_reason']} completion_tokens={v['completion_tokens']} {v['seconds']}s {v.get('error', '')}")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(f"Full report: {args.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
