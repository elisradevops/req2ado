"""Regression tests: long blocking work must never run on the event loop.

Prod incident: /ingest's post-parse figure-captioning pass called the
synchronous vision client directly inside the `async def` handler, so for the
whole pass (~7s per figure, minutes in total) uvicorn could answer nothing,
not even /health. Six missed liveness probes later kubelet SIGKILLed the
container mid-job. Every test here runs the real app on ONE event loop
(httpx ASGITransport) and asserts a concurrent /health stays responsive while
a deliberately blocking fake does its work.
"""

import asyncio
import time
import uuid
from pathlib import Path

import httpx
import pytest

import app.main as main_module
from app.main import app
from app.vision.orchestrator_vision_client import FigureVisionResult

FIXTURES = Path(__file__).parent / "fixtures"
MAX_HEALTH_LATENCY_SECONDS = 0.15
BLOCK_SECONDS = 0.4


class _BlockingVisionClient:
    """A vision client whose call blocks its calling thread, like the real
    synchronous httpx client does for the duration of a model call."""

    def describe_figure(self, image_bytes, mime_type=None, document_context=None, user_id=None, model=None):
        time.sleep(BLOCK_SECONDS)
        return FigureVisionResult(significant=True, description="a real caption")


async def _max_health_stall_while(work: "asyncio.Future[httpx.Response]", client: httpx.AsyncClient) -> float:
    """Polls /health every ~50ms until `work` finishes; returns the longest
    time /health went unanswered, from the moment a probe was DUE to the
    moment its reply arrived. A blocked loop shows up here as a late wake-up
    of this poller (it cannot even send the request), not as a slow request,
    so the measurement runs from the scheduled send time, not the actual one."""
    slowest = 0.0
    probes = 0
    while not work.done():
        due = time.monotonic()
        response = await client.get("/health")
        slowest = max(slowest, time.monotonic() - due)
        probes += 1
        assert response.status_code == 200
        await asyncio.sleep(0.05)
        # asyncio.sleep returns late if the loop was blocked meanwhile.
        slowest = max(slowest, time.monotonic() - due - 0.05)
    assert probes >= 2, "the blocking work finished before /health could be polled twice"
    return slowest


@pytest.mark.parametrize("concurrency", [1, 4])
async def test_health_stays_responsive_during_the_figure_captioning_pass(monkeypatch, concurrency) -> None:
    monkeypatch.setattr(main_module, "_vision_client", _BlockingVisionClient())
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", concurrency)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        with open(FIXTURES / "multi_figure.docx", "rb") as f:
            upload = asyncio.ensure_future(
                client.post(
                    "/ingest",
                    params={"mode": "survey", "user_id": "test-user", "primer_context": f"event-loop-{uuid.uuid4()}"},
                    files={"file": ("multi_figure.docx", f.read(), "application/octet-stream")},
                )
            )
        slowest = await _max_health_stall_while(upload, client)
        response = await upload

    assert response.status_code == 200
    assert [fig["caption"] for fig in response.json()["figures"]] == ["a real caption"] * len(response.json()["figures"])
    assert slowest < MAX_HEALTH_LATENCY_SECONDS, f"/health went unanswered for {slowest:.2f}s while figures were being captioned"


async def _health_stall_during(request_coro_factory) -> tuple[httpx.Response, float]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        work = asyncio.ensure_future(request_coro_factory(client))
        slowest = await _max_health_stall_while(work, client)
        return await work, slowest


async def test_health_stays_responsive_during_dedup_upsert_batch(monkeypatch) -> None:
    class _BlockingEmbedClient:
        def embed(self, texts, user_id=None):
            time.sleep(BLOCK_SECONDS)
            return [[0.1, 0.2, 0.3] for _ in texts]

    class _NoopVectorStore:
        def upsert_many(self, items, area_path):
            return None

    monkeypatch.setattr(main_module, "_embed_client", _BlockingEmbedClient())
    monkeypatch.setattr(main_module, "_vector_store", _NoopVectorStore())

    response, slowest = await _health_stall_during(
        lambda client: client.post(
            "/dedup/upsert-batch",
            json={"items": [{"item_id": "1", "title": "t", "text": "x", "area_path": "A"}], "user_id": "u"},
        )
    )

    assert response.status_code == 200
    assert slowest < MAX_HEALTH_LATENCY_SECONDS, f"/health went unanswered for {slowest:.2f}s during a dedup upsert"


async def test_health_stays_responsive_during_score_item(monkeypatch) -> None:
    class _Caps:
        context_budget_tokens = 4096

    def _blocking_retrieve(user_id, description, embed_client, store):
        time.sleep(BLOCK_SECONDS)
        return "kb", []

    def _blocking_score(*args, **kwargs):
        time.sleep(BLOCK_SECONDS)
        return 80, [], None, None

    monkeypatch.setattr(main_module, "retrieve_context", _blocking_retrieve)
    monkeypatch.setattr(main_module, "_resolve_caps", lambda *a, **k: _Caps())
    monkeypatch.setattr(main_module, "_get_criteria_retriever", lambda user_id: None)
    monkeypatch.setattr(main_module, "score_single_requirement_text", _blocking_score)

    response, slowest = await _health_stall_during(
        lambda client: client.post(
            "/score-item", json={"description": "The system shall do X.", "user_id": "u", "model": "m"},
        )
    )

    assert response.status_code == 200
    assert response.json()["quality_score"] == 80
    assert slowest < MAX_HEALTH_LATENCY_SECONDS, f"/health went unanswered for {slowest:.2f}s during /score-item"
