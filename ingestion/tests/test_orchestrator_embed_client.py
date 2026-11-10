import threading
from concurrent.futures import ThreadPoolExecutor

import httpx

from app.dedup.orchestrator_embed_client import OrchestratorEmbedClient, _EMBED_REQUEST_TIMEOUT_SECONDS


def test_embed_calls_the_orchestrator_embed_endpoint_with_bearer_auth() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-bearer"
        assert request.url.path == "/llm/embed"
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2, 0.3]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    result = client.embed(["The unit shall survive a drop."])
    assert result == [[0.1, 0.2, 0.3]]


def test_embed_sends_all_texts_in_one_request() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"embeddings": [[0.1], [0.2]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.embed(["text one", "text two"])
    assert captured["body"]["texts"] == ["text one", "text two"]


def test_embed_uses_a_real_timeout_not_httpxs_5_second_default(monkeypatch) -> None:
    # Regression guard for a confirmed real bug: this client previously
    # constructed httpx.Client() with NO explicit timeout at all, so
    # httpx's own 5-second default applied -- every sibling LLM client in
    # this codebase (OrchestratorLlmClient: 1800s, OrchestratorVisionClient:
    # 300s) uses a real timeout sized for a cold local model precisely
    # because Ollama evicts an idle model after a few minutes, so this
    # client's first call in a job's lifetime is not guaranteed warm either.
    captured_kwargs: dict = {}
    real_client_cls = httpx.Client

    class _CapturingClient(real_client_cls):
        def __init__(self, *args, **kwargs):
            captured_kwargs.update(kwargs)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _CapturingClient)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[0.1]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.embed(["text"])

    assert captured_kwargs.get("timeout") == _EMBED_REQUEST_TIMEOUT_SECONDS
    assert _EMBED_REQUEST_TIMEOUT_SECONDS > 5  # must be meaningfully larger than httpx's own default


def test_embed_raises_on_non_200_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "unauthorized"})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="wrong-token")
    client._transport = httpx.MockTransport(handler)

    import pytest

    with pytest.raises(httpx.HTTPStatusError):
        client.embed(["text"])


def test_embed_sends_x_req2ado_user_id_header_when_supplied() -> None:
    # The orchestrator's /llm/embed route now requires this header to
    # resolve which user's vaulted Open WebUI connection to use -- a
    # missing/unknown header is rejected with 401 (no shared/global
    # fallback credential exists any more). See OrchestratorLlmClient.
    # _post_chat's own doc comment for the full contract this mirrors.
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["user_id_header"] = request.headers.get("x-req2ado-user-id")
        return httpx.Response(200, json={"embeddings": [[0.1]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.embed(["text"], user_id="user-1")

    assert captured["user_id_header"] == "user-1"


def test_embed_omits_the_user_id_header_entirely_when_not_supplied() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["has_header"] = "x-req2ado-user-id" in request.headers
        return httpx.Response(200, json={"embeddings": [[0.1]]})

    client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.embed(["text"])

    assert captured["has_header"] is False


def test_shared_singleton_client_sends_the_correct_distinct_user_id_header_for_each_concurrent_call() -> None:
    """Mirrors test_orchestrator_llm_client.py's own concurrency regression
    test for the identical hazard: OrchestratorEmbedClient is constructed as
    a module-level singleton in main.py (`_embed_client`), shared across
    every concurrent request the process handles (dedup checks, KB
    retrieval, KB ingestion, criteria-grounded scoring can all be in flight
    for different users at once). `user_id` MUST be a pure per-call
    argument -- if it were ever stored on `self`, this test's forced
    concurrent overlap (via a threading.Barrier) would expose one thread's
    identity leaking into the other's request."""
    barrier = threading.Barrier(2)
    captured_by_marker: dict[str, str | None] = {}
    lock = threading.Lock()

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(request.content)
        marker = body["texts"][0]
        barrier.wait(timeout=5)
        with lock:
            captured_by_marker[marker] = request.headers.get("x-req2ado-user-id")
        return httpx.Response(200, json={"embeddings": [[0.1]]})

    shared_client = OrchestratorEmbedClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    shared_client._transport = httpx.MockTransport(handler)

    def call_as(user_id: str) -> None:
        shared_client.embed([user_id], user_id=user_id)

    with ThreadPoolExecutor(max_workers=2) as executor:
        future_a = executor.submit(call_as, "user-a")
        future_b = executor.submit(call_as, "user-b")
        future_a.result(timeout=5)
        future_b.result(timeout=5)

    assert captured_by_marker == {"user-a": "user-a", "user-b": "user-b"}


# -- one pooled HTTP client instead of a new connection per call ------------------------------------------------------------------------
# A job makes one /llm/embed call per node (hundreds, several at a time); each used to open and close its own client.
import pytest  # noqa: E402


def _echo_length(request: httpx.Request) -> httpx.Response:
    import json

    texts = json.loads(request.content)["texts"]
    return httpx.Response(200, json={"embeddings": [[float(len(t)), 1.0] for t in texts]})


@pytest.fixture
def clients_built(monkeypatch) -> list:
    built: list = []
    real = httpx.Client

    def counting(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        client = real(*args, **kwargs)
        built.append(client)
        return client

    monkeypatch.setattr(httpx, "Client", counting)
    return built


def _pooled_client() -> OrchestratorEmbedClient:
    client = OrchestratorEmbedClient("http://orchestrator", "bearer")
    client._transport = httpx.MockTransport(_echo_length)
    return client


def test_many_calls_share_one_http_client(clients_built) -> None:
    client = _pooled_client()
    for text in ("a", "bb", "ccc"):
        assert client.embed([text], user_id="u1") == [[float(len(text)), 1.0]]
    assert len(clients_built) == 1


def test_concurrent_first_calls_still_build_exactly_one_client(clients_built) -> None:
    client = _pooled_client()
    barrier = threading.Barrier(8)

    def call() -> None:
        barrier.wait()
        client.embed(["x"], user_id="u1")

    threads = [threading.Thread(target=call) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(clients_built) == 1


def test_a_transport_swapped_after_the_first_call_is_honoured(clients_built) -> None:
    # Only tests swap the transport of the module-level client after it was built.
    client = _pooled_client()
    client.embed(["x"], user_id="u1")
    client._transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"embeddings": [[9.0]]}))
    assert client.embed(["x"], user_id="u1") == [[9.0]]
    assert len(clients_built) == 2
    assert clients_built[0].is_closed


def test_close_releases_the_client_and_the_next_call_builds_a_new_one(clients_built) -> None:
    client = _pooled_client()
    client.embed(["x"], user_id="u1")
    client.close()
    assert clients_built[0].is_closed
    client.embed(["x"], user_id="u1")
    assert len(clients_built) == 2
