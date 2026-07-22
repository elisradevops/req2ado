import json

from app.leveling.narration_publisher import LevelingProgress, NarrationPublisher


class _FakeRedis:
    def __init__(self, raises: Exception | None = None) -> None:
        self._raises = raises
        self.set_calls: list[tuple] = []
        self.publish_calls: list[tuple] = []

    def set(self, key, value, ex=None):
        if self._raises:
            raise self._raises
        self.set_calls.append((key, value, ex))

    def publish(self, channel, payload):
        self.publish_calls.append((channel, payload))


def _progress(**overrides) -> LevelingProgress:
    defaults = dict(
        phase="infer_hierarchy",
        branch_index=0,
        branch_count=3,
        blocks_done=10,
        blocks_total=50,
        kb_grounded=False,
        kb_citations=[],
    )
    defaults.update(overrides)
    return LevelingProgress(**defaults)


def test_publish_writes_current_key_and_publishes_to_channel() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress())

    assert redis_client.set_calls[0][0] == "job-events:job-1:narration"
    assert redis_client.publish_calls[0][0] == "job-events:job-1"
    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["type"] == "narration"
    assert payload["phase"] == "infer_hierarchy"
    assert payload["branchIndex"] == 0
    assert payload["branchCount"] == 3
    assert payload["blocksDone"] == 10
    assert payload["blocksTotal"] == 50
    assert payload["kbGrounded"] is False
    assert payload["kbCitations"] == []
    assert "message" in payload


def test_publish_includes_kb_citations_in_camelcase_when_grounded() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(
        _progress(kb_grounded=True, kb_citations=[{"source_file": "doc.docx", "similarity": 0.9}])
    )

    payload = json.loads(redis_client.publish_calls[0][1])
    assert payload["kbGrounded"] is True
    assert payload["kbCitations"] == [{"sourceFile": "doc.docx", "similarity": 0.9}]
    assert "grounded with 1 KB file" in payload["message"]


def test_publish_never_raises_when_redis_fails() -> None:
    redis_client = _FakeRedis(raises=RuntimeError("redis unavailable"))
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress())  # must not raise


def test_publish_message_includes_branch_position_when_branch_index_is_set() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(branch_index=2, branch_count=5))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert "section 3 of 5" in payload["message"]


def test_publish_message_omits_branch_position_when_branch_index_is_none() -> None:
    redis_client = _FakeRedis()
    publisher = NarrationPublisher(redis_client, "job-1")

    publisher.publish(_progress(phase="infer_trace_links", branch_index=None))

    payload = json.loads(redis_client.publish_calls[0][1])
    assert "section" not in payload["message"]
