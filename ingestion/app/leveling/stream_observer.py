from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# Job transparency (docs/job-transparency-implementation-plan.md, B8): an
# incremental reader for the JSON a streamed model call is producing. It only
# ever feeds the live display -- the call's real result still comes from the
# existing full-text parse (`_parse_json_object` and its tolerances), so
# nothing here can change what a job produces. Any problem simply stops the
# observation.
#
# Supports the two shapes the drafting calls return:
#   {"<id>": {...}, "<id>": {...}}          row-id-keyed objects (title/tags,
#                                           synthesis, parent summary)
#   {"nodes": [{...}, {...}]}               an array of node objects (sections)


@dataclass(frozen=True)
class ObservedItem:
    """One completed child value of the root object."""

    # The row id, or "nodes[3]" for an element of an array-valued key.
    key: str
    # Order of completion, starting at 0.
    index: int
    raw: str
    # The parsed object, or None when the raw text is not valid JSON by itself.
    value: Any | None


class StreamObserver:
    """Feed it text as it streams in (any chunking, including splits inside a
    string or an escape); `on_item` fires once for each child object as soon
    as it closes. Never raises."""

    def __init__(self, on_item: Callable[[ObservedItem], None]) -> None:
        self._on_item = on_item
        self._depth = 0
        self._stack: list[str] = []
        self._in_string = False
        self._escape = False
        self._expecting_key = False
        self._collecting_key = False
        self._key_chars: list[str] = []
        self._current_key: str | None = None
        self._array_key: str | None = None
        self._array_index = 0
        self._capture: list[str] | None = None
        self._capture_depth = 0
        self._item_key = ""
        self._emitted = 0
        self.broken = False

    @property
    def pending_key(self) -> str | None:
        """The row id whose value the model is writing right now, if known."""
        if self._capture is not None:
            return self._item_key
        return self._current_key

    @property
    def items_seen(self) -> int:
        return self._emitted

    def feed(self, text: str) -> None:
        if self.broken or not text:
            return
        try:
            for char in text:
                self._step(char)
        except Exception:  # noqa: BLE001 - observation must never break the call
            logger.warning("Stream observer stopped after an error", exc_info=True)
            self.broken = True

    def _emit(self) -> None:
        raw = "".join(self._capture or [])
        try:
            value: Any | None = json.loads(raw)
        except ValueError:
            value = None
        item = ObservedItem(key=self._item_key, index=self._emitted, raw=raw, value=value)
        self._emitted += 1
        self._on_item(item)

    def _step(self, char: str) -> None:
        if self._in_string:
            if self._collecting_key:
                self._key_chars.append(char)
            if self._capture is not None:
                self._capture.append(char)
            if self._escape:
                self._escape = False
            elif char == "\\":
                self._escape = True
            elif char == '"':
                self._in_string = False
                if self._collecting_key:
                    self._collecting_key = False
                    raw_key = "".join(self._key_chars[:-1])  # drop the closing quote
                    try:
                        self._current_key = json.loads(f'"{raw_key}"')
                    except ValueError:
                        self._current_key = raw_key
            return

        if char == '"':
            self._in_string = True
            if self._capture is not None:
                self._capture.append(char)
            elif self._depth == 1 and self._expecting_key:
                self._collecting_key = True
                self._key_chars = []
            return

        if char in "{[":
            self._depth += 1
            self._stack.append(char)
            if self._depth == 1:
                if char == "{":
                    self._expecting_key = True
                return
            if self._capture is not None:
                self._capture.append(char)
            elif self._depth == 2 and self._stack[0] == "{":
                if char == "{":
                    self._capture, self._capture_depth = [char], 2
                    self._item_key = self._current_key or ""
                else:
                    self._array_key, self._array_index = self._current_key or "", 0
            elif (
                self._depth == 3 and self._stack[1] == "["
                and self._array_key is not None and char == "{"
            ):
                self._capture, self._capture_depth = [char], 3
                self._item_key = f"{self._array_key}[{self._array_index}]"
            return

        if char in "}]":
            if self._capture is not None:
                self._capture.append(char)
            if self._depth > 0:
                self._depth -= 1
                self._stack.pop()
            if self._capture is not None and self._depth == self._capture_depth - 1:
                self._emit()
                self._capture = None
                if self._capture_depth == 3:
                    self._array_index += 1
            if self._depth == 1 and char == "]":
                self._array_key = None
            return

        if char == ":" and self._depth == 1:
            self._expecting_key = False
            return
        if char == "," and self._depth == 1:
            self._expecting_key = True
            self._current_key = None
            return
        if self._capture is not None:
            self._capture.append(char)
