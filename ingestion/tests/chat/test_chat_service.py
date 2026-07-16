import json

import pytest

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
