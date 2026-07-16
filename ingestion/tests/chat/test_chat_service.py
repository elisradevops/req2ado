import json

import pytest

from app.chat.chat_client import PROPOSAL_SENTINEL
from app.chat.chat_service import _SentinelWindow, run_chat_turn
from app.chat.redis_publisher import RedisChatPublisher


class _FakeRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []
        self.store: dict[str, str] = {}

    async def publish(self, channel: str, message: str) -> None:
        self.published.append((channel, message))

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)


@pytest.mark.asyncio
async def test_publish_chunk_publishes_to_the_job_local_id_channel() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001 - test seam, avoids a real Redis connection

    await publisher.publish_chunk("job-1", "n0", "Hel")

    channel, message = fake.published[0]
    assert channel == "chat:job-1:n0"
    assert json.loads(message) == {"type": "chunk", "delta": "Hel"}


@pytest.mark.asyncio
async def test_publish_done_includes_proposal_and_model() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    await publisher.publish_done("job-1", "n0", "Here you go", "New title", None, "llama3.1")

    _, message = fake.published[0]
    assert json.loads(message) == {
        "type": "done",
        "message": "Here you go",
        "proposedTitle": "New title",
        "proposedDescription": None,
        "model": "llama3.1",
    }


@pytest.mark.asyncio
async def test_publish_error_includes_reason() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    await publisher.publish_error("job-1", "n0", "LLM unreachable")

    _, message = fake.published[0]
    assert json.loads(message) == {"type": "error", "reason": "LLM unreachable"}


@pytest.mark.asyncio
async def test_is_aborted_true_and_clears_the_key() -> None:
    fake = _FakeRedis()
    fake.store["chat:abort:job-1:n0"] = "1"
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    assert await publisher.is_aborted("job-1", "n0") is True
    assert "chat:abort:job-1:n0" not in fake.store


@pytest.mark.asyncio
async def test_is_aborted_false_when_no_key_set() -> None:
    fake = _FakeRedis()
    publisher = RedisChatPublisher.__new__(RedisChatPublisher)
    publisher._redis = fake  # noqa: SLF001

    assert await publisher.is_aborted("job-1", "n0") is False


def test_sentinel_window_emits_text_with_no_sentinel_after_holdback() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    emitted = window.feed("Hello there") + window.flush()
    assert emitted == "Hello there"


def test_sentinel_window_never_emits_sentinel_split_across_two_feeds() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    # Split the sentinel itself across two feed() calls.
    half = len(PROPOSAL_SENTINEL) // 2
    part1, part2 = PROPOSAL_SENTINEL[:half], PROPOSAL_SENTINEL[half:]
    emitted = window.feed(f"before {part1}") + window.feed(f"{part2} after")
    assert PROPOSAL_SENTINEL not in emitted


def test_sentinel_window_stops_emitting_once_sentinel_found() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    first = window.feed(f"message text{PROPOSAL_SENTINEL}")
    second = window.feed('{"proposedTitle": "x"}')
    assert first == "message text"
    assert second == ""
    assert window.flush() == ""


def test_sentinel_window_flush_after_no_sentinel_returns_remaining_buffer() -> None:
    window = _SentinelWindow(PROPOSAL_SENTINEL)
    window.feed("partial")
    assert window.flush() == "partial"


class _FakeChatClient:
    def __init__(self, deltas: list[str]) -> None:
        self._deltas = deltas

    async def stream_reply(self, messages, model):  # noqa: ANN001, ARG002 - test double
        for delta in self._deltas:
            yield delta


class _FakePublisher:
    def __init__(self, aborted: bool = False) -> None:
        self.chunks: list[str] = []
        self.done: dict | None = None
        self.errors: list[str] = []
        self._aborted = aborted

    async def publish_chunk(self, job_id, local_id, delta):  # noqa: ANN001, ARG002
        self.chunks.append(delta)

    async def publish_done(  # noqa: ANN001, ARG002
        self, job_id, local_id, message, proposed_title, proposed_description, model
    ):
        self.done = {
            "message": message,
            "proposedTitle": proposed_title,
            "proposedDescription": proposed_description,
            "model": model,
        }

    async def publish_error(self, job_id, local_id, reason):  # noqa: ANN001, ARG002
        self.errors.append(reason)

    async def is_aborted(self, job_id, local_id):  # noqa: ANN001, ARG002
        return self._aborted


@pytest.mark.asyncio
async def test_run_chat_turn_publishes_chunks_then_done_with_no_proposal() -> None:
    deltas = ["Sure, ", "here's ", "why."]
    chat_client = _FakeChatClient(deltas)
    publisher = _FakePublisher()

    await run_chat_turn(
        "job-1", "n0",
        {
            "type": "Requirement",
            "title": "T",
            "description": "D",
            "childType": None,
            "qualityIssues": [],
        },
        [], "why is this ambiguous?", "llama3.1", None, None, None,
        chat_client, publisher,
    )

    assert "".join(publisher.chunks) == "Sure, here's why."
    assert publisher.done == {
        "message": "Sure, here's why.",
        "proposedTitle": None,
        "proposedDescription": None,
        "model": "llama3.1",
    }
    assert publisher.errors == []


@pytest.mark.asyncio
async def test_run_chat_turn_extracts_proposal_and_hides_json_from_chunks() -> None:
    deltas = [
        "Tighter version.\n",
        PROPOSAL_SENTINEL,
        '\n{"proposedTitle": "New", "proposedDescription": "Better"}',
    ]
    chat_client = _FakeChatClient(deltas)
    publisher = _FakePublisher()

    await run_chat_turn(
        "job-1", "n0",
        {
            "type": "Requirement",
            "title": "T",
            "description": "D",
            "childType": None,
            "qualityIssues": [],
        },
        [], "make this testable", None, None, None, None,
        chat_client, publisher,
    )

    assert "".join(publisher.chunks) == "Tighter version."
    assert PROPOSAL_SENTINEL not in "".join(publisher.chunks)
    assert publisher.done == {
        "message": "Tighter version.",
        "proposedTitle": "New",
        "proposedDescription": "Better",
        "model": "",
    }


@pytest.mark.asyncio
async def test_run_chat_turn_stops_and_publishes_error_when_aborted() -> None:
    chat_client = _FakeChatClient(["one", "two", "three"])
    publisher = _FakePublisher(aborted=True)

    await run_chat_turn(
        "job-1", "n0",
        {
            "type": "Requirement",
            "title": "T",
            "description": "D",
            "childType": None,
            "qualityIssues": [],
        },
        [], "hello", None, None, None, None,
        chat_client, publisher,
    )

    assert publisher.done is None
    assert publisher.errors == ["stopped by user"]


@pytest.mark.asyncio
async def test_run_chat_turn_grounds_system_prompt_with_kb_context_when_area_path_supplied(monkeypatch) -> None:
    # Regression guard for a caller of retrieve_context() the P3c plan initially
    # missed (retrieval.py/llm_leveling.py's test suites cover the other
    # caller) — locks that run_chat_turn correctly unpacks the (context,
    # citations) tuple and threads context into the system prompt.
    monkeypatch.setattr(
        "app.chat.chat_service.retrieve_context",
        lambda area_path, query_text, embed_client, vector_store, **_: ("The receiver shall decode HDR10 metadata.", ["spec.docx"]),
    )

    captured: dict[str, list[dict]] = {}

    class _CapturingChatClient:
        async def stream_reply(self, messages, model):  # noqa: ANN001, ARG002 - test double
            captured["messages"] = messages
            yield "Sure."

    publisher = _FakePublisher()

    await run_chat_turn(
        "job-1", "n0",
        {
            "type": "Requirement",
            "title": "T",
            "description": "D",
            "childType": None,
            "qualityIssues": [],
        },
        [], "make this testable", "llama3.1", "Project\\Area1", object(), object(),
        _CapturingChatClient(), publisher,
    )

    system_prompt = captured["messages"][0]["content"]
    assert "The receiver shall decode HDR10 metadata." in system_prompt
    assert publisher.done is not None


@pytest.mark.asyncio
async def test_run_chat_turn_publishes_error_on_llm_failure_never_raises() -> None:
    class _FailingChatClient:
        async def stream_reply(self, messages, model):  # noqa: ANN001, ARG002
            raise RuntimeError("LLM unreachable")
            yield  # pragma: no cover - unreachable, makes this an async generator

    publisher = _FakePublisher()

    await run_chat_turn(
        "job-1", "n0",
        {
            "type": "Requirement",
            "title": "T",
            "description": "D",
            "childType": None,
            "qualityIssues": [],
        },
        [], "hello", None, None, None, None,
        _FailingChatClient(), publisher,
    )

    assert publisher.done is None
    assert publisher.errors == ["LLM unreachable"]
