from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from app.leveling.live_emitter import LiveEmitter
from app.leveling.stage_units import StageCounter
from app.leveling.stream_observer import ObservedItem, StreamObserver

logger = logging.getLogger(__name__)

# Job transparency (docs/job-transparency-implementation-plan.md, B7): turns the
# text of one streamed drafting call into live frames on a lane of its own.
# Display only. It reads the stream through a StreamObserver, never touches the
# text the caller parses, and every method swallows its own errors.


class DraftingDisplay:
    """One streamed call's view on the screen.

    `inputs` maps each row id sent to the model to the owner's own text for it
    (used as the short "working on" excerpt). The model answers in input order,
    so before it names a row we show the first one, and when it starts a new row
    we show that row."""

    def __init__(
        self, emitter: LiveEmitter, inputs: Mapping[str, str | None], *,
        stage: str | None = None, counter: StageCounter | None = None,
    ) -> None:
        # With a stage and a counter, each item the model finishes also moves the
        # exact count for that pass while the call is still running.
        self._stage = stage
        self._counter = counter
        self._items = 0
        self._emitter = emitter
        self._inputs = dict(inputs)
        self._order = list(self._inputs)
        self._lane = emitter.acquire_lane()
        self._shown: str | None = None
        self._observer = StreamObserver(self._on_item)
        self._ended = False

    @property
    def lane(self) -> int:
        return self._lane

    def start(self) -> None:
        if self._order:
            self._show(self._order[0])

    def feed(self, text: str) -> None:
        self._observer.feed(text)
        pending = self._observer.pending_key
        if pending and pending != self._shown and pending in self._inputs:
            self._show(pending)

    def reset(self) -> None:
        """The call is being retried: clear what this lane shows."""
        try:
            self._emitter.reset(lane=self._lane)
            self._shown = None
            self._observer = StreamObserver(self._on_item)
            self._items = 0
            self._clear_count()
        except Exception:  # noqa: BLE001 - observation must never break the job
            logger.debug("live reset failed", exc_info=True)

    def end(self) -> None:
        """The call is over (finished or given up): clear the lane, send what is
        still queued and give the lane back."""
        if self._ended:
            return
        self._ended = True
        try:
            self._clear_count()
            self._emitter.reset(lane=self._lane)
            self._emitter.flush()
        except Exception:  # noqa: BLE001 - observation must never break the job
            logger.debug("live end failed", exc_info=True)
        finally:
            self._emitter.release_lane(self._lane)

    def _clear_count(self) -> None:
        # The finished call's items are added by the pass itself (as finished
        # work), so the running count is dropped here.
        if self._counter is not None and self._stage is not None:
            self._counter.clear_in_flight(self._stage, self._lane)

    def _show(self, key: str) -> None:
        self._shown = key
        self._emitter.working_on(lane=self._lane, ref=key, excerpt=self._inputs.get(key))

    def _on_item(self, item: ObservedItem) -> None:
        self._items += 1
        if self._counter is not None and self._stage is not None:
            self._counter.in_flight(self._stage, self._lane, self._items)
        value: Any = item.value
        title = text = None
        if isinstance(value, dict):
            raw_title = value.get("title")
            title = raw_title if isinstance(raw_title, str) else None
            raw_text = value.get("text") or value.get("description")
            text = raw_text if isinstance(raw_text, str) else None
        self._emitter.item(lane=self._lane, ref=item.key, title=title, excerpt=text)
