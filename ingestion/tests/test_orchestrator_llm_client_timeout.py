"""How long one call to the orchestrator waits: the configured LLM_REQUEST_TIMEOUT_SECONDS for every client, unless a caller that stops waiting
earlier (the explanation, the rewrite prediction) set `request_timeout_seconds` on its own per-request client."""
import json

import httpx
import pytest

from app.survey import orchestrator_llm_client as module
from app.survey.orchestrator_llm_client import OrchestratorLlmClient


class NullDisplay:
    def feed(self, delta: str) -> None:
        pass

    def reset(self) -> None:
        pass


def make_client(monkeypatch) -> tuple[OrchestratorLlmClient, list]:
    timeouts: list = []
    real = httpx.Client

    class Recording(real):
        def __init__(self, *args, **kwargs):
            timeouts.append(kwargs.get("timeout"))
            super().__init__(*args, **kwargs)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/llm/chat/stream"):
            body = json.dumps({"delta": "{}"}) + "\n" + json.dumps({"done": True}) + "\n"
            return httpx.Response(200, content=body.encode())
        if request.url.path.endswith("/llm/show"):
            return httpx.Response(200, json={"contextLength": 8000, "capabilities": []})
        return httpx.Response(200, json={"content": "{}"})

    monkeypatch.setattr("app.survey.orchestrator_llm_client.httpx.Client", Recording)
    client = OrchestratorLlmClient("http://orchestrator", "bearer")
    client._transport = httpx.MockTransport(handler)
    return client, timeouts


CALLS = {
    "plain chat": lambda c: c._post_chat({"messages": []}, "u1"),
    "streamed chat": lambda c: c._chat_json_streaming({"messages": []}, "u1", NullDisplay()),
    "model lookup": lambda c: c.show_model("m", "u1"),
}


@pytest.mark.parametrize("call", CALLS)
def test_a_client_that_sets_nothing_keeps_the_configured_timeout_on_every_call(call, monkeypatch) -> None:
    client, timeouts = make_client(monkeypatch)
    assert client.request_timeout_seconds is None
    CALLS[call](client)
    assert timeouts == [module._LLM_REQUEST_TIMEOUT_SECONDS]


@pytest.mark.parametrize("call", CALLS)
def test_a_client_with_its_own_timeout_uses_it_on_every_call(call, monkeypatch) -> None:
    client, timeouts = make_client(monkeypatch)
    client.request_timeout_seconds = 65
    CALLS[call](client)
    assert timeouts == [65]


def test_the_timeout_belongs_to_the_client_that_set_it_not_to_the_class(monkeypatch) -> None:
    capped, _ = make_client(monkeypatch)
    capped.request_timeout_seconds = 65
    other, timeouts = make_client(monkeypatch)
    other._post_chat({"messages": []}, "u1")
    assert timeouts == [module._LLM_REQUEST_TIMEOUT_SECONDS]
