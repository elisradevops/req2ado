from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Job transparency (docs/job-transparency-implementation-plan.md, B8): the
# source-side throttle and publisher for "live" frames -- what a running job is
# working on right now. Frames are tiny, rate-limited per job, and coalesced so
# the event bus and the browser never see more than a few per second however
# fast the model streams. Everything here is best-effort: a failure drops a
# frame and is logged once, and never reaches the job.

LIVE_TTL_SECONDS = 2 * 3600
TITLE_MAX_CHARS = 200
COMPARE_TEXT_MAX_CHARS = 400
EXCERPT_HARD_MAX_CHARS = 1000
# How many finished-item frames may wait to be sent. Items are the one kind that
# must not be lost (the outline and the "written" count depend on every one), but
# the rate limit would let them pile up when a model answers faster than 4 items
# a second; flush() sends the whole backlog at the end of a call. The ceiling
# matches the most items the document map (and the browser) will track.
MAX_QUEUED_FRAMES = 6000
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

# Frames of these kinds say "what is happening now": a newer one for the same
# lane makes an older unsent one pointless, so only the latest is kept.
_COALESCED_KINDS = {"working_on", "writing", "ocr_page"}


def live_channel(job_id: str) -> str:
    return f"job-events:{job_id}:live"


def live_latest_key(job_id: str) -> str:
    return f"job-events:{job_id}:live-latest"


def live_done_key(job_id: str) -> str:
    """Hash of the refs of finished items (field = ref). The event stream replays only
    the latest frame per lane, so this is how a page opened mid-run learns what is done."""
    return f"job-events:{job_id}:live-done"


def live_seq_key(job_id: str) -> str:
    return f"job-events:{job_id}:live-seq"


def clip_text(text: str | None, max_chars: int) -> str | None:
    """One line, no control characters, cut at a word boundary with an
    ellipsis when it does not fit. None and blank text give None."""
    if not text:
        return None
    cleaned = " ".join(_CONTROL_CHARS.sub(" ", text).split())
    if not cleaned:
        return None
    if len(cleaned) <= max_chars:
        return cleaned
    cut = cleaned[: max_chars - 1]
    # If the next character is a space, the last word in `cut` is complete.
    if cleaned[max_chars - 1] != " ":
        boundary = cut.rfind(" ")
        if boundary >= max_chars // 2:
            cut = cut[:boundary]
    return cut.rstrip() + "…"


class _RedisLike(Protocol):
    def incr(self, name: str) -> Any: ...
    def expire(self, name: str, time: int) -> Any: ...
    def hset(self, name: str, key: str, value: str) -> Any: ...
    def publish(self, channel: str, message: str) -> Any: ...


class LiveEmitter:
    """Thread-safe: chunks and branches may run concurrently, each on its own
    `lane`. `seq` comes from Redis INCR so it stays monotonic across lanes,
    threads and a worker restart."""

    def __init__(
        self,
        redis_client: _RedisLike,
        job_id: str,
        *,
        hz: float = 4.0,
        excerpt_max_chars: int = 240,
        max_queue: int = MAX_QUEUED_FRAMES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._redis = redis_client
        self._job_id = job_id
        self._hz = max(0.1, float(hz))
        self._excerpt_max = max(1, min(int(excerpt_max_chars), EXCERPT_HARD_MAX_CHARS))
        self._clock = clock
        self._lock = threading.Lock()
        # Frames are taken and sent under this lock, one thread at a time, so they
        # reach Redis in the order they were taken. Without it two threads could take
        # a lane's older and newer frame and publish them the other way round,
        # leaving a stale "working on" as the lane's latest state after its reset.
        self._send_lock = threading.Lock()
        self._capacity = max(1.0, self._hz)
        self._tokens = self._capacity
        self._last_refill = clock()
        self._queue: deque[dict[str, Any]] = deque(maxlen=max_queue)
        self._pending: dict[int, dict[str, Any]] = {}
        self._busy_lanes: set[int] = set()
        self._warned = False
        self.last_item_ref: str | None = None

    # ---- public API -------------------------------------------------------

    def working_on(
        self, *, lane: int = 0, ref: str | None = None, title: str | None = None,
        item_type: str | None = None, excerpt: str | None = None, cursor: float | None = None,
    ) -> None:
        self._submit(
            {"kind": "working_on", "lane": lane, "ref": ref, "title": title,
             "itemType": item_type, "excerpt": excerpt, "cursor": cursor}
        )

    def writing(
        self, *, lane: int = 0, ref: str | None = None, title: str | None = None,
        item_type: str | None = None, partial: bool = True,
    ) -> None:
        self._submit(
            {"kind": "writing", "lane": lane, "ref": ref, "title": title,
             "itemType": item_type, "partial": partial}
        )

    def item(
        self, *, lane: int = 0, ref: str, title: str | None, item_type: str | None = None,
        excerpt: str | None = None,
    ) -> None:
        """A finished work item. Never coalesced: every item is delivered."""
        self.last_item_ref = str(ref)
        self._submit(
            {"kind": "item", "lane": lane, "ref": ref, "title": title, "itemType": item_type,
             "excerpt": excerpt, "partial": False}
        )

    def compare(
        self, *, lane: int = 0, kind: str, a_ref: str, a_text: str, b_ref: str, b_text: str,
        similarity: float,
    ) -> None:
        self._submit(
            {"kind": "compare", "lane": lane,
             "compare": {"kind": kind, "similarity": similarity,
                         "a": {"ref": a_ref, "text": a_text}, "b": {"ref": b_ref, "text": b_text}}}
        )

    def ocr_page(self, *, page: int, pages: int, excerpt: str | None = None) -> None:
        self._submit(
            {"kind": "ocr_page", "lane": 0, "page": page, "pages": pages, "excerpt": excerpt}
        )

    def acquire_lane(self) -> int:
        """The lowest lane number not in use, so concurrent calls each get their
        own lane and a finished call's lane is reused."""
        with self._lock:
            lane = 0
            while lane in self._busy_lanes:
                lane += 1
            self._busy_lanes.add(lane)
            return lane

    def release_lane(self, lane: int) -> None:
        with self._lock:
            self._busy_lanes.discard(lane)

    def reset(self, *, lane: int = 0) -> None:
        """A call is being retried: forget anything unsent for the lane and tell
        the screen to clear what it shows for it."""
        with self._lock:
            self._pending.pop(lane, None)
        self._submit({"kind": "reset", "lane": lane})

    def flush(self) -> None:
        """Sends everything still waiting (end of a chunk or call), ignoring the rate
        limit: this is the catch-up for items that finished faster than it allows."""
        with self._send_lock:
            to_send: list[dict[str, Any]] = []
            with self._lock:
                while self._queue:
                    to_send.append(self._queue.popleft())
                for lane in sorted(self._pending):
                    to_send.append(self._pending[lane])
                self._pending.clear()
            for fields in to_send:
                self._send(fields)

    # ---- internals --------------------------------------------------------

    def _submit(self, fields: dict[str, Any]) -> None:
        try:
            with self._lock:
                if fields["kind"] in _COALESCED_KINDS:
                    self._pending[fields["lane"]] = fields
                else:
                    self._queue.append(fields)
            with self._send_lock:
                with self._lock:
                    to_send = self._take_allowed()
                for ready in to_send:
                    self._send(ready)
        except Exception:  # noqa: BLE001 - observation must never break the job
            self._warn_once()

    def _take_allowed(self) -> list[dict[str, Any]]:
        now = self._clock()
        self._tokens = min(self._capacity, self._tokens + (now - self._last_refill) * self._hz)
        self._last_refill = now
        out: list[dict[str, Any]] = []
        while self._tokens >= 1.0 and (self._queue or self._pending):
            if self._queue:
                out.append(self._queue.popleft())
            else:
                lane = min(self._pending)
                out.append(self._pending.pop(lane))
            self._tokens -= 1.0
        return out

    def _build(self, fields: dict[str, Any], seq: int) -> dict[str, Any]:
        frame: dict[str, Any] = {
            "type": "live",
            "seq": seq,
            "lane": fields["lane"],
            "kind": fields["kind"],
            "emittedAt": datetime.now(UTC).isoformat(),
        }
        if fields.get("ref") is not None:
            frame["ref"] = str(fields["ref"])
        title = clip_text(fields.get("title"), TITLE_MAX_CHARS)
        if title is not None:
            frame["title"] = title
        if fields.get("itemType") is not None:
            frame["itemType"] = str(fields["itemType"])
        excerpt = clip_text(fields.get("excerpt"), self._excerpt_max)
        if excerpt is not None:
            frame["excerpt"] = excerpt
        cursor = fields.get("cursor")
        if cursor is not None:
            frame["cursor"] = max(0.0, min(1.0, float(cursor)))
        if "partial" in fields:
            frame["partial"] = bool(fields["partial"])
        compare = fields.get("compare")
        if compare is not None:
            frame["compare"] = {
                "kind": compare["kind"],
                "similarity": max(0.0, min(1.0, float(compare["similarity"]))),
                "a": {"ref": str(compare["a"]["ref"]),
                      "text": clip_text(compare["a"]["text"], COMPARE_TEXT_MAX_CHARS) or ""},
                "b": {"ref": str(compare["b"]["ref"]),
                      "text": clip_text(compare["b"]["text"], COMPARE_TEXT_MAX_CHARS) or ""},
            }
        if fields.get("page") is not None:
            frame["page"] = int(fields["page"])
        if fields.get("pages") is not None:
            frame["pages"] = int(fields["pages"])
        return frame

    def _send(self, fields: dict[str, Any]) -> None:
        try:
            seq_key = live_seq_key(self._job_id)
            seq = int(self._redis.incr(seq_key))
            self._redis.expire(seq_key, LIVE_TTL_SECONDS)
            payload = json.dumps(self._build(fields, seq), ensure_ascii=False)
            self._redis.hset(live_latest_key(self._job_id), str(fields["lane"]), payload)
            self._redis.expire(live_latest_key(self._job_id), LIVE_TTL_SECONDS)
            self._redis.publish(live_channel(self._job_id), payload)
            if fields["kind"] == "item" and fields.get("ref") is not None:
                self._redis.hset(live_done_key(self._job_id), str(fields["ref"]), "1")
                self._redis.expire(live_done_key(self._job_id), LIVE_TTL_SECONDS)
        except Exception:  # noqa: BLE001 - observation must never break the job
            self._warn_once()

    def _warn_once(self) -> None:
        if not self._warned:
            self._warned = True
            logger.warning(
                "Live frame dropped for job %s (further drops not logged)",
                self._job_id, exc_info=True,
            )
