"""/level answers as a stream of lines: a heartbeat while the run works, then ONE result (or error) line.

The whole SURVEY run used to be one silent HTTP request, so its caller's socket timer (an hour) was a limit on the job's total duration:
two Opus jobs that were still scoring were cut at 60 minutes. A heartbeat every few seconds shows the connection is alive and the run
is working; the caller's limit is now silence, not total time. Closing the stream (the caller went away) cancels the run."""
import asyncio
import json

import pytest

from app import job_cancel
from app.level_stream import ndjson_stream


async def collect(stream) -> list[dict]:
    return [json.loads(line) async for line in stream]


def failure(exc: Exception) -> tuple[int, str]:
    return 502, f"failed: {exc}"


def test_heartbeats_while_the_run_works_then_one_result_line_with_the_payload() -> None:
    async def scenario():
        async def work() -> dict:
            await asyncio.sleep(0.35)
            return {"tree": {"nodes": []}, "rubric": {"version": "v1", "degraded": False}}

        lines = await collect(ndjson_stream(work, job_cancel.CancelToken(), heartbeat_seconds=0.1, describe_failure=failure))
        kinds = [line["type"] for line in lines]
        assert kinds[-1] == "result" and kinds.count("result") == 1 and kinds.count("heartbeat") >= 2
        assert lines[-1]["tree"] == {"nodes": []} and lines[-1]["rubric"] == {"version": "v1", "degraded": False}
        assert all("elapsed" in line for line in lines if line["type"] == "heartbeat")

    asyncio.run(scenario())


def test_a_quick_run_sends_no_heartbeat() -> None:
    async def scenario():
        async def work() -> dict:
            return {"tree": {}}

        lines = await collect(ndjson_stream(work, job_cancel.CancelToken(), heartbeat_seconds=5, describe_failure=failure))
        assert [line["type"] for line in lines] == ["result"]

    asyncio.run(scenario())


def test_a_failing_run_ends_with_one_error_line_and_no_result() -> None:
    async def scenario():
        async def work() -> dict:
            await asyncio.sleep(0.15)
            raise ValueError("boom")

        lines = await collect(ndjson_stream(work, job_cancel.CancelToken(), heartbeat_seconds=0.1, describe_failure=failure))
        assert [line["type"] for line in lines][-1] == "error" and "result" not in [line["type"] for line in lines]
        assert lines[-1]["status"] == 502 and lines[-1]["detail"] == "failed: boom"

    asyncio.run(scenario())


def test_closing_the_stream_cancels_the_run() -> None:
    async def scenario():
        token = job_cancel.CancelToken()
        finished = asyncio.Event()

        async def work() -> dict:
            try:
                await asyncio.sleep(30)
            finally:
                finished.set()
            return {}

        stream = ndjson_stream(work, token, heartbeat_seconds=0.05, describe_failure=failure)
        assert json.loads(await stream.__anext__())["type"] == "heartbeat"
        await stream.aclose()  # what the server does when the caller disconnects
        assert token.cancelled is True
        await asyncio.wait_for(finished.wait(), timeout=2)  # the work itself was cancelled too

    asyncio.run(scenario())


def test_an_existing_token_can_be_installed_as_the_scope_of_a_run() -> None:
    async def scenario():
        token = job_cancel.CancelToken()
        with job_cancel.cancellation_scope(token) as installed:
            assert installed is token and job_cancel.current_token() is token
            token.cancel()
            with pytest.raises(job_cancel.JobCancelled):
                job_cancel.raise_if_cancelled()

    asyncio.run(scenario())
