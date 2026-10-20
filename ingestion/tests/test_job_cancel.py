"""A job whose caller has gone away (the orchestrator gave up, restarted, or the job was cancelled) must stop spending
model calls. Before this, ingestion finished the whole abandoned job (41 minutes of scoring, regrouping and trace-link calls
in a prod run) and those calls starved the next jobs of the same model."""
import asyncio

import httpx
import pytest

from app import job_cancel
from app.job_cancel import JobCancelled
from app.logging_context import job_id_scope
from app.survey.orchestrator_llm_client import OrchestratorLlmClient


def test_a_cancelled_job_raises_at_the_next_check_and_other_jobs_are_unaffected() -> None:
    job_cancel.cancel("job-a")
    try:
        with job_id_scope("job-a"):
            with pytest.raises(JobCancelled):
                job_cancel.raise_if_cancelled()
        with job_id_scope("job-b"):
            job_cancel.raise_if_cancelled()
        job_cancel.raise_if_cancelled()  # no job in scope: never raises
    finally:
        job_cancel.clear("job-a")
    with job_id_scope("job-a"):
        job_cancel.raise_if_cancelled()  # cleared


def test_no_model_call_is_made_for_a_cancelled_job() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    job_cancel.cancel("job-c")
    try:
        with job_id_scope("job-c"):
            with pytest.raises(JobCancelled):
                client._post_chat({"messages": []}, None)
    finally:
        job_cancel.clear("job-c")
    assert calls == []


class _Request:
    def __init__(self, disconnect_after: int | None) -> None:
        self.polls, self.disconnect_after = 0, disconnect_after

    async def is_disconnected(self) -> bool:
        self.polls += 1
        return self.disconnect_after is not None and self.polls > self.disconnect_after


def test_the_watcher_cancels_the_job_when_the_caller_disconnects() -> None:
    async def scenario() -> bool:
        request = _Request(disconnect_after=2)
        async with job_cancel.watch_for_disconnect(request, "job-d", poll_seconds=0.01):
            await asyncio.sleep(0.2)
        return job_cancel.is_cancelled("job-d")

    try:
        assert asyncio.run(scenario()) is True
    finally:
        job_cancel.clear("job-d")


def test_a_caller_that_stays_does_not_cancel_and_the_watcher_stops_with_the_request() -> None:
    async def scenario() -> tuple[bool, int]:
        request = _Request(disconnect_after=None)
        async with job_cancel.watch_for_disconnect(request, "job-e", poll_seconds=0.01):
            await asyncio.sleep(0.05)
        polls_at_exit = request.polls
        await asyncio.sleep(0.05)
        return job_cancel.is_cancelled("job-e"), request.polls - polls_at_exit

    cancelled, polls_after_exit = asyncio.run(scenario())
    assert cancelled is False and polls_after_exit == 0


def test_a_request_without_a_job_id_is_not_watched() -> None:
    async def scenario() -> int:
        request = _Request(disconnect_after=0)
        async with job_cancel.watch_for_disconnect(request, None, poll_seconds=0.01):
            await asyncio.sleep(0.05)
        return request.polls

    assert asyncio.run(scenario()) == 0


def test_the_level_route_refuses_to_return_the_result_of_a_cancelled_job_and_forgets_the_flag() -> None:
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.main import app
    from app.workitem.model import WorkItemTree
    from tests.test_request_identity import _doc

    def cancelled_while_running(*args, **kwargs):
        job_cancel.cancel("job-route")
        return WorkItemTree(nodes=[], warnings=[])

    with patch("app.main._build_survey_tree_with_scoring", side_effect=cancelled_while_running):
        response = TestClient(app).post(
            "/level?mode=survey&job_id=job-route", content=_doc().model_dump_json(),
            headers={"Content-Type": "application/json", "X-Req2Ado-User-Id": "u"},
        )
    assert response.status_code == 499
    assert job_cancel.is_cancelled("job-route") is False
