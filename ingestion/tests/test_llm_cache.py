# ingestion/tests/test_llm_cache.py
from app.prompts.assembly import DataBlock, build_call
from app.survey.llm_cache import LlmResponseCache, payload_key


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


_PARAMS = {"temperature": 0, "model": "m", "think": False, "maxTokens": 100}


def _payload(
    prompt: str = "propose_acceptance_criteria",
    version: int | None = None,
    source: str = "{}",
    **params,
) -> dict:
    call = build_call(prompt, version=version, blocks=[DataBlock("source", source)])
    return call.payload({**_PARAMS, **params})


def test_a_changed_prompt_gives_a_different_key_and_an_unchanged_one_the_same_key() -> None:
    assert payload_key(_payload(version=4)) == payload_key(_payload(version=4))
    assert payload_key(_payload(version=3)) != payload_key(_payload(version=4))
    assert payload_key(_payload("judge_duplicate_pair")) != payload_key(
        _payload("judge_parameter_pairs")
    )


def test_the_key_differs_by_the_data_sent() -> None:
    assert payload_key(_payload(source="text a")) != payload_key(_payload(source="text b"))


def test_the_key_differs_by_every_model_parameter_and_the_schema() -> None:
    base = payload_key(_payload())
    for change in (
        {"model": "other"},
        {"numCtx": 8192},
        {"topK": 40},
        {"minP": 0.1},
        {"seed": 7},
        {"maxTokens": 200},
        {"responseSchema": {"type": "object"}},
        {"budgetKind": "study"},
    ):
        assert payload_key(_payload(**change)) != base, change


def test_the_scope_partitions_the_cache_by_what_is_not_in_the_request() -> None:
    payload = _payload()
    assert payload_key(payload, "user-a") != payload_key(payload, "user-b")
    assert payload_key(payload, "user-a", 0) != payload_key(payload, "user-a", 1)
    assert payload_key(payload, "user-a", 1) == payload_key(payload, "user-a", 1)


def test_an_attached_files_id_is_not_part_of_the_key_only_whether_one_is_attached() -> None:
    first_upload = payload_key(_payload(fileId="file-1"))
    assert payload_key(_payload(fileId="file-2")) == first_upload
    assert payload_key(_payload()) != first_upload


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
