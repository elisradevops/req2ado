"""A long run answered as a stream of lines instead of one silent response.

`/level` runs for many minutes (a SURVEY of a large document: an hour on a slow model). As one request, its caller's socket timer had to
be longer than the longest run, and was: an hour, so two jobs that were still scoring were cut at 60 minutes. Streamed, the caller's limit
becomes silence: a heartbeat line every few seconds says the run is alive, and the stream ends with exactly one line, the result or the
error (a failure after the first byte can no longer change the HTTP status, so it travels as a line).

Closing the stream (the caller disconnected) cancels the run's token and the work task, as a dropped plain request did."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable

from app.job_cancel import CancelToken

NDJSON = "application/x-ndjson"


def line(payload: dict) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"


async def ndjson_stream(
    work: Callable[[], Awaitable[dict]],
    token: CancelToken,
    *,
    heartbeat_seconds: float,
    describe_failure: Callable[[Exception], tuple[int, str]],
) -> AsyncIterator[bytes]:
    """Runs `work` and yields `{"type":"heartbeat","elapsed":s}` lines while it runs, then `{"type":"result", **payload}` or
    `{"type":"error","status":n,"detail":"..."}` (from `describe_failure`)."""
    started = time.monotonic()
    task = asyncio.ensure_future(work())
    task.add_done_callback(lambda t: None if t.cancelled() else t.exception())  # a failure is reported as a line, never "never retrieved"
    try:
        while True:
            done, _pending = await asyncio.wait({task}, timeout=heartbeat_seconds)
            if done:
                break
            yield line({"type": "heartbeat", "elapsed": round(time.monotonic() - started)})
        try:
            payload = task.result()
        except Exception as exc:  # noqa: BLE001 -- whatever stopped the run is the answer, as a line
            status, detail = describe_failure(exc)
            yield line({"type": "error", "status": status, "detail": detail})
            return
        yield line({"type": "result", **payload})
    finally:
        if not task.done():
            token.cancel()  # the next model call of the run raises, so it winds down in moments
            task.cancel()
