"""A job whose caller has gone away (the orchestrator gave up, restarted, or the job was cancelled) must stop spending
model calls. Before this, ingestion finished the whole abandoned job (41 minutes of scoring, regrouping and trace-link calls
in a prod run) and those calls starved the next jobs of the same model.

The cancel flag belongs to ONE request (a token in a contextvar), not to a job id: a re-run of the same job id (BullMQ
reprocessing a stalled job) must not inherit the cancellation of the request that was abandoned."""
import asyncio

import httpx
import pytest

from app import job_cancel
from app.job_cancel import JobCancelled
from app.survey.orchestrator_llm_client import OrchestratorLlmClient


def test_a_cancelled_scope_raises_at_the_next_check_and_other_scopes_are_unaffected() -> None:
    with job_cancel.cancellation_scope() as token:
        job_cancel.raise_if_cancelled()  # not cancelled yet
        token.cancel()
        with pytest.raises(JobCancelled):
            job_cancel.raise_if_cancelled()
    with job_cancel.cancellation_scope():
        job_cancel.raise_if_cancelled()  # a new scope starts clean
    job_cancel.raise_if_cancelled()  # no scope at all (chat, rescoring): never raises


def test_a_rerun_of_the_same_job_does_not_inherit_the_cancellation_of_the_abandoned_run() -> None:
    with job_cancel.cancellation_scope() as abandoned:
        abandoned.cancel()
        # the abandoned run is still winding down (an in-flight call) when the same job id is run again:
        with job_cancel.cancellation_scope():
            job_cancel.raise_if_cancelled()
        with pytest.raises(JobCancelled):
            job_cancel.raise_if_cancelled()


def test_no_model_call_is_made_in_a_cancelled_scope() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"content": "{}"})

    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(handler)
    with job_cancel.cancellation_scope() as token:
        token.cancel()
        with pytest.raises(JobCancelled):
            client._post_chat({"messages": []}, None)
    assert calls == []


class _Request:
    def __init__(self, disconnect_after: int | None) -> None:
        self.polls, self.disconnect_after = 0, disconnect_after

    async def is_disconnected(self) -> bool:
        self.polls += 1
        return self.disconnect_after is not None and self.polls > self.disconnect_after


def test_the_watcher_cancels_the_scope_when_the_caller_disconnects() -> None:
    async def scenario() -> bool:
        with job_cancel.cancellation_scope() as token:
            async with job_cancel.watch_for_disconnect(_Request(disconnect_after=2), token, poll_seconds=0.01):
                await asyncio.sleep(0.2)
            return token.cancelled

    assert asyncio.run(scenario()) is True


def test_a_caller_that_stays_does_not_cancel_and_the_watcher_stops_with_the_request() -> None:
    async def scenario() -> tuple[bool, int]:
        request = _Request(disconnect_after=None)
        with job_cancel.cancellation_scope() as token:
            async with job_cancel.watch_for_disconnect(request, token, poll_seconds=0.01):
                await asyncio.sleep(0.05)
            polls_at_exit = request.polls
            await asyncio.sleep(0.05)
            return token.cancelled, request.polls - polls_at_exit

    cancelled, polls_after_exit = asyncio.run(scenario())
    assert cancelled is False and polls_after_exit == 0


def test_the_level_route_refuses_to_return_the_result_of_a_cancelled_run() -> None:
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    from app.main import app
    from app.workitem.model import WorkItemTree
    from tests.test_request_identity import _doc

    def cancelled_while_running(*args, **kwargs):
        job_cancel.current_token().cancel()  # the work runs inside the request's scope (contextvar crosses the threadpool)
        return WorkItemTree(nodes=[], warnings=[])

    with patch("app.main._build_survey_tree_with_scoring", side_effect=cancelled_while_running):
        response = TestClient(app).post(
            "/level?mode=survey&job_id=job-route", content=_doc().model_dump_json(),
            headers={"Content-Type": "application/json", "X-Req2Ado-User-Id": "u"},
        )
    assert response.status_code == 499
    # and the next run of the same job id is not affected
    with patch("app.main._build_survey_tree_with_scoring", return_value=WorkItemTree(nodes=[], warnings=[])):
        again = TestClient(app).post(
            "/level?mode=survey&job_id=job-route", content=_doc().model_dump_json(),
            headers={"Content-Type": "application/json", "X-Req2Ado-User-Id": "u"},
        )
    assert again.status_code == 200


def test_the_token_reaches_the_chunk_workers_that_make_the_scoring_calls() -> None:
    from app.leveling.bounded_chunks import run_chunks_bounded

    def worker(chunk: list[int]) -> str:
        try:
            job_cancel.raise_if_cancelled()
        except JobCancelled:
            return "cancelled"
        return "ran"

    with job_cancel.cancellation_scope() as token:
        token.cancel()
        outcomes = list(run_chunks_bounded([[1], [2], [3]], worker, 3))
    assert [o.value for o in outcomes] == ["cancelled"] * 3


def test_a_pool_that_submits_in_context_sees_the_token_and_a_plain_submit_does_not() -> None:
    from concurrent.futures import ThreadPoolExecutor

    def probe() -> bool:
        try:
            job_cancel.raise_if_cancelled()
        except JobCancelled:
            return True
        return False

    with job_cancel.cancellation_scope() as token:
        token.cancel()
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert job_cancel.submit_in_context(pool, probe).result() is True
            assert pool.submit(probe).result() is False  # the reason every submit site needs the helper
