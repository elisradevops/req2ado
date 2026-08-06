# ingestion/tests/test_llm_cache.py
from app.survey.llm_cache import LlmResponseCache, cache_key


class _FakeRedis:
    """Same hand-written fake-redis convention as test_narration_publisher.py --
    no fakeredis dependency, just the subset of the real client's interface
    LlmResponseCache actually calls."""

    def __init__(self, raises: Exception | None = None) -> None:
        self._store: dict[str, bytes] = {}
        self._raises = raises
        self.set_calls: list[tuple] = []

    def get(self, key: str):
        if self._raises:
            raise self._raises
        return self._store.get(key)

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        if self._raises:
            raise self._raises
        self.set_calls.append((key, value, ex))
        self._store[key] = value.encode() if isinstance(value, str) else value


def test_cache_key_differs_by_operation() -> None:
    assert cache_key("op_a", "model", None, None, None, "same text") != cache_key("op_b", "model", None, None, None, "same text")


def test_cache_key_differs_by_model() -> None:
    assert cache_key("op", "model-a", None, None, None, "text") != cache_key("op", "model-b", None, None, None, "text")


def test_cache_key_differs_by_num_ctx_top_k_min_p() -> None:
    base = cache_key("op", "model", 8192, 40, 0.1, "text")
    assert base != cache_key("op", "model", 4096, 40, 0.1, "text")
    assert base != cache_key("op", "model", 8192, 20, 0.1, "text")
    assert base != cache_key("op", "model", 8192, 40, 0.5, "text")


def test_cache_key_differs_by_parts() -> None:
    assert cache_key("op", "model", None, None, None, "text a") != cache_key("op", "model", None, None, None, "text b")


def test_cache_key_is_stable_for_identical_inputs() -> None:
    assert cache_key("op", "model", 8192, 40, 0.1, "text", {"a": 1}) == cache_key("op", "model", 8192, 40, 0.1, "text", {"a": 1})


def test_get_returns_none_on_a_miss() -> None:
    cache = LlmResponseCache(_FakeRedis())
    assert cache.get("some-key") is None


def test_set_then_get_round_trips_a_json_serializable_value() -> None:
    cache = LlmResponseCache(_FakeRedis())
    cache.set("some-key", {"nodes": [{"id": "n0"}], "truncated": False})
    assert cache.get("some-key") == {"nodes": [{"id": "n0"}], "truncated": False}


def test_set_passes_the_configured_ttl_to_redis() -> None:
    redis_client = _FakeRedis()
    cache = LlmResponseCache(redis_client, ttl_seconds=60)
    cache.set("some-key", {"a": 1})
    assert redis_client.set_calls[0][2] == 60


def test_get_fails_open_when_redis_raises() -> None:
    cache = LlmResponseCache(_FakeRedis(raises=ConnectionError("redis unavailable")))
    assert cache.get("some-key") is None


def test_set_fails_open_when_redis_raises() -> None:
    cache = LlmResponseCache(_FakeRedis(raises=ConnectionError("redis unavailable")))
    cache.set("some-key", {"a": 1})  # must not raise


def test_get_treats_non_json_stored_value_as_a_miss() -> None:
    redis_client = _FakeRedis()
    redis_client._store["some-key"] = b"not json"
    cache = LlmResponseCache(redis_client)
    assert cache.get("some-key") is None
