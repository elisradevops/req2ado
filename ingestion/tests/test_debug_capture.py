from app.debug_capture import DebugCapture
from app.logging_context import job_id_scope


class _FakeRedis:
    def __init__(self, raises: Exception | None = None) -> None:
        self._raises = raises
        self._store: dict[str, tuple[str, int]] = {}

    def setex(self, key, ttl, value):
        if self._raises:
            raise self._raises
        self._store[key] = (value, ttl)

    def get(self, key):
        # Mirrors real redis-py: accepts either str or bytes keys transparently.
        key_str = key.decode() if isinstance(key, bytes) else key
        entry = self._store.get(key_str)
        return entry[0].encode() if entry else None

    def scan_iter(self, match: str):
        # Real redis SCAN glob-matches "*" -- this fake only needs to
        # support the exact pattern DebugCapture.list_captures builds
        # (prefix:job_id:*:*), so a simple prefix check is enough.
        prefix = match.split("*")[0]
        for key in self._store:
            if key.startswith(prefix):
                yield key.encode()


def test_capture_no_ops_outside_any_job_id_scope() -> None:
    redis_client = _FakeRedis()
    capture = DebugCapture(redis_client)

    capture.capture("kb_relevance", "root", "some raw response")

    assert redis_client._store == {}


def test_capture_stores_the_raw_response_keyed_by_job_id_kind_and_identifier() -> None:
    redis_client = _FakeRedis()
    capture = DebugCapture(redis_client)

    with job_id_scope("job-123"):
        capture.capture("kb_relevance", "br0", "malformed JSON in LLM response content: 'Based'")

    assert redis_client._store == {
        "req2ado:debug:job-123:kb_relevance:br0": ("malformed JSON in LLM response content: 'Based'", 7 * 24 * 3600)
    }


def test_capture_truncates_an_oversized_raw_response() -> None:
    redis_client = _FakeRedis()
    capture = DebugCapture(redis_client)

    with job_id_scope("job-123"):
        capture.capture("kb_relevance", "root", "x" * 50_000)

    stored_value, _ = redis_client._store["req2ado:debug:job-123:kb_relevance:root"]
    assert len(stored_value) == 20_000


def test_capture_swallows_a_redis_failure_without_raising() -> None:
    redis_client = _FakeRedis(raises=ConnectionError("redis down"))
    capture = DebugCapture(redis_client)

    with job_id_scope("job-123"):
        capture.capture("kb_relevance", "root", "content")  # must not raise


def test_list_captures_returns_every_capture_for_the_job() -> None:
    redis_client = _FakeRedis()
    capture = DebugCapture(redis_client)

    with job_id_scope("job-123"):
        capture.capture("kb_relevance", "br0", "content one")
        capture.capture("infer_trace_links", "document", "content two")
    with job_id_scope("job-456"):
        capture.capture("kb_relevance", "br0", "a different job's content")

    results = capture.list_captures("job-123")
    assert len(results) == 2
    assert {"kind": "kb_relevance", "identifier": "br0", "content": "content one"} in results
    assert {"kind": "infer_trace_links", "identifier": "document", "content": "content two"} in results


def test_list_captures_returns_empty_when_nothing_was_captured() -> None:
    redis_client = _FakeRedis()
    capture = DebugCapture(redis_client)

    assert capture.list_captures("job-with-no-failures") == []
