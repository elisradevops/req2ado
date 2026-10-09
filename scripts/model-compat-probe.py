"""Model compatibility probe: what does each model on the LLM proxy accept, and how does it fail?

Read-only and SYNTHETIC: it sends tiny made-up requirement sentences through the orchestrator's own
/llm routes (the same path real jobs take), so it measures the app's real request/response contract.
It never prints the bearer token or any document text.

Run it inside the ingestion pod (it needs the app's prompt/schema code and the proxy bearer from settings):

    kubectl -n <ns> exec -i <ingestion-pod> -- env SMOKE_USER=<userId> [SMOKE_MODELS=a,b] python - < scripts/model-compat-probe.py

SMOKE_USER is any real user id (it selects whose vaulted proxy credential is used). SMOKE_MODELS limits the
models; by default every chat model whose name contains "claude" or "gpt" is probed.

Per model it prints RESULT lines (one per test, with the proxy's own error text, shortened) and one VERDICT
line. The error texts are what the orchestrator's negotiation parsers are written against, so keep them.
"""
import base64
import io
import json
import os
import time

import httpx

from app.config import settings
from app.prompts import load_prompt
from app.survey.keyed_calls import describe_output, items_schema, normalize_keyed_result
from app.survey.keyed_specs import TITLE_TAGS_SPEC
from app.survey.orchestrator_llm_client import _parse_json_object, _strip_json_fence
from app.workitem.model import RequirementTag

BASE = settings.orchestrator_url
HEADERS = {"Authorization": f"Bearer {settings.llm_proxy_bearer}", "X-Req2Ado-User-Id": os.environ["SMOKE_USER"]}
CLIENT = httpx.Client(timeout=180)
SKIP = ("embed", "minilm", "whisper", "tts", "dall", "image", "rerank", "arena")
ROWS = {f"r{i}": f"The unit {i} shall operate at {10 + i} V within {1 + i % 5} percent." for i in range(10)}
SPEC = TITLE_TAGS_SPEC
TOOL = {
    "type": "function",
    "function": {
        "name": "get_value",
        "description": "Returns the stored value for x.",
        "parameters": {"type": "object", "properties": {"x": {"type": "integer"}}, "required": ["x"]},
    },
}


def ok(status):
    return status in (200, 201)


def clean(text, limit=300):
    return " ".join(str(text).split())[:limit]


def note(status, response):
    return clean(response) if status == "EXC" else clean(getattr(response, "text", "<no text>"))


def post(path, body):
    started = time.time()
    try:
        response = CLIENT.post(BASE + path, json=body, headers=HEADERS)
        return response.status_code, time.time() - started, response
    except Exception as exc:  # noqa: BLE001 -- one model's hang must not stop the sweep
        return "EXC", time.time() - started, exc


def report(model, test, status, seconds, detail=""):
    print(f"RESULT model={model} test={test} status={status} secs={seconds:.1f} {detail}", flush=True)


def system_prompt(mode):
    return load_prompt(
        "title_and_tags_for_rows",
        tag_vocabulary=", ".join(t.value for t in RequirementTag),
        row_count=str(len(ROWS)),
        output_format=describe_output(SPEC, mode),
    )


def png_with_text():
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (200, 80), "white")
    ImageDraw.Draw(image).text((20, 30), "HELLO", fill="black")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def probe(model, image):
    verdict = {"array": -1, "prompt": -1, "vision": "NO", "stream": "NO", "tools": "NO", "maxtok": "ok"}
    base = {"model": model, "temperature": 0}
    ask_ok = [{"role": "user", "content": "Reply with the single word OK."}]

    status, seconds, response = post("/llm/show", {"model": model})
    report(model, "show", status, seconds, note(status, response))

    status, seconds, response = post("/llm/chat", {**base, "messages": ask_ok, "maxTokens": 50})
    report(model, "basic50", status, seconds, f"len={len(response.json().get('content', ''))}" if ok(status) else note(status, response))
    if not ok(status) and "max_tokens" in note(status, response).lower():
        verdict["maxtok"] = "needs_max_completion_tokens"

    # No temperature at all: tells whether the model's default is usable without the app's retry.
    status, seconds, response = post("/llm/chat", {"model": model, "messages": ask_ok, "maxTokens": 200})
    report(model, "no_temperature", status, seconds, "accepted" if ok(status) else note(status, response))

    for label, tokens in (("maxTokens20000", 20000), ("maxTokens200000", 200000)):
        status, seconds, response = post("/llm/chat", {**base, "messages": ask_ok, "maxTokens": tokens})
        report(model, label, status, seconds, "accepted" if ok(status) else note(status, response))

    for label, mode, with_schema in (("array_schema", "array", True), ("prompt_only", "none", False)):
        body = {
            **base,
            "messages": [{"role": "system", "content": system_prompt(mode)}, {"role": "user", "content": json.dumps(ROWS)}],
            "maxTokens": 4000,
        }
        if with_schema:
            body["responseSchema"] = items_schema(SPEC)
        status, seconds, response = post("/llm/chat", body)
        if ok(status):
            try:
                got = normalize_keyed_result(_parse_json_object(_strip_json_fence(response.json()["content"])), list(ROWS), SPEC.fields)
                verdict["array" if with_schema else "prompt"] = len(got)
                report(model, label, status, seconds, f"matched={len(got)}/{len(ROWS)} finish={response.json().get('finishReason')}")
            except Exception as exc:  # noqa: BLE001
                report(model, label, status, seconds, f"unparseable {type(exc).__name__}")
        else:
            report(model, label, status, seconds, note(status, response))

    status, seconds, response = post(
        "/llm/chat",
        {**base, "messages": [{"role": "user", "content": "Call get_value with x=7."}], "tools": [TOOL], "toolChoice": "auto", "maxTokens": 2000},
    )
    if ok(status):
        calls = response.json().get("toolCalls") or []
        verdict["tools"] = "YES" if calls else "NO_CALL"
        report(model, "tool_call", status, seconds, f"tool_calls={len(calls)} finish={response.json().get('finishReason')}")
    else:
        verdict["tools"] = "ERROR"
        report(model, "tool_call", status, seconds, note(status, response))

    status, seconds, response = post("/llm/chat/stream", {**base, "messages": [{"role": "user", "content": "Count from 1 to 5."}], "maxTokens": 200})
    verdict["stream"] = "YES" if ok(status) and len(response.content) > 0 else "NO"
    report(model, "stream", status, seconds, f"bytes={len(response.content)}" if ok(status) else note(status, response))

    if image is None:
        report(model, "vision", "skipped", 0.0, "PIL unavailable")
    else:
        status, seconds, response = post(
            "/llm/vision",
            {"model": model, "prompt": "What word is written in the image? Answer with the word only.", "images": [image], "mimeType": "image/png"},
        )
        description = response.json().get("description", "") if ok(status) else ""
        verdict["vision"] = "YES" if ok(status) and "hello" in description.lower() else "NO"
        report(model, "vision", status, seconds, clean(description) if ok(status) else note(status, response))
    return verdict


def main():
    listed = CLIENT.get(BASE + "/llm/models", headers=HEADERS).json()["models"]
    print("MODELS", len(listed), listed, flush=True)
    wanted = [m for m in os.environ.get("SMOKE_MODELS", "").split(",") if m] or [m for m in listed if "claude" in m.lower() or "gpt" in m.lower()]
    try:
        image = png_with_text()
    except Exception as exc:  # noqa: BLE001
        print(f"NOTE PIL unavailable: {type(exc).__name__}", flush=True)
        image = None
    for model in wanted:
        if any(s in model.lower() for s in SKIP):
            print(f"RESULT model={model} test=skipped")
            continue
        try:
            v = probe(model, image)
        except Exception as exc:  # noqa: BLE001
            print(f"RESULT model={model} test=ERROR {type(exc).__name__}: {clean(exc)}", flush=True)
            continue
        supported = "YES" if len(ROWS) in (v["array"], v["prompt"]) else "NO"
        print(
            f"VERDICT model={model} structured={supported} array={v['array']}/{len(ROWS)} prompt={v['prompt']}/{len(ROWS)} "
            f"vision={v['vision']} stream={v['stream']} tools={v['tools']} max_tokens={v['maxtok']}",
            flush=True,
        )


main()
