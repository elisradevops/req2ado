import app.main as main_module


class _RecordingEmbedClient:
    """Records which user_id each embed() call was made with -- CRITERIA_CORPUS
    is small enough that a real embedding value doesn't matter for these
    tests, only which identity resolved the call."""

    def __init__(self) -> None:
        self.calls: list[str | None] = []

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        self.calls.append(user_id)
        return [[0.1, 0.2] for _ in texts]


def _reset_criteria_retriever_cache(monkeypatch, embed_client) -> _RecordingEmbedClient:
    # Isolates this test module from _get_criteria_retriever's real
    # module-level cache (main.py's _criteria_retrievers/
    # _criteria_retrievers_build_attempted) -- monkeypatch auto-reverts
    # both after each test, so no cross-test pollution of this shared state.
    monkeypatch.setattr(main_module, "_embed_client", embed_client)
    monkeypatch.setattr(main_module, "_criteria_retrievers", {})
    monkeypatch.setattr(main_module, "_criteria_retrievers_build_attempted", set())
    return embed_client


def test_builds_a_separate_retriever_per_user_id(monkeypatch) -> None:
    # The real bug this closes: _get_criteria_retriever() used to be a
    # single process-lifetime singleton built once, for whichever request
    # happened to trigger it first, and cached forever after -- wrong once
    # the corpus embed requires a REAL per-user Open WebUI connection (no
    # shared/global fallback credential exists any more).
    embed_client = _reset_criteria_retriever_cache(monkeypatch, _RecordingEmbedClient())

    retriever_a = main_module._get_criteria_retriever("user-a")
    retriever_b = main_module._get_criteria_retriever("user-b")

    assert retriever_a is not None
    assert retriever_b is not None
    assert retriever_a is not retriever_b
    # One corpus-embed call per user, each carrying that user's own identity.
    assert embed_client.calls == ["user-a", "user-b"]


def test_caches_the_same_users_retriever_without_re_embedding(monkeypatch) -> None:
    embed_client = _reset_criteria_retriever_cache(monkeypatch, _RecordingEmbedClient())

    first = main_module._get_criteria_retriever("user-a")
    second = main_module._get_criteria_retriever("user-a")

    assert first is second
    assert embed_client.calls == ["user-a"]  # only the first call actually embedded


def test_degrades_to_none_for_one_user_without_affecting_a_different_user(monkeypatch) -> None:
    class _FailingForOneUser(_RecordingEmbedClient):
        def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
            if user_id == "user-broken":
                raise RuntimeError("401 from /llm/embed -- no connection configured")
            return super().embed(texts, user_id=user_id)

    _reset_criteria_retriever_cache(monkeypatch, _FailingForOneUser())

    broken = main_module._get_criteria_retriever("user-broken")
    healthy = main_module._get_criteria_retriever("user-a")

    assert broken is None  # ungrounded scoring for this user, not a hard failure
    assert healthy is not None  # a different user's own connection is unaffected


def test_two_parallel_jobs_of_one_user_share_one_build_and_neither_fails(monkeypatch) -> None:
    # Prod: two jobs of the same user started a minute apart; the second one read the cache while the first was still
    # building the retriever and died with KeyError (the user id was marked "attempted" before the entry existed).
    import threading
    import time

    class SlowEmbedClient(_RecordingEmbedClient):
        def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
            time.sleep(0.2)
            return super().embed(texts, user_id=user_id)

    embed_client = _reset_criteria_retriever_cache(monkeypatch, SlowEmbedClient())
    results: list[object] = []
    errors: list[BaseException] = []

    def run() -> None:
        try:
            results.append(main_module._get_criteria_retriever("user-a"))
        except BaseException as exc:  # noqa: BLE001 -- the test is about any failure
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len(results) == 4 and all(r is results[0] and r is not None for r in results)
    assert embed_client.calls == ["user-a"]  # built once


def test_a_failed_build_is_remembered_as_ungrounded_and_not_retried(monkeypatch) -> None:
    class FailingEmbedClient(_RecordingEmbedClient):
        def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
            super().embed(texts, user_id=user_id)
            raise RuntimeError("embed proxy down")

    embed_client = _reset_criteria_retriever_cache(monkeypatch, FailingEmbedClient())
    assert main_module._get_criteria_retriever("user-a") is None
    assert main_module._get_criteria_retriever("user-a") is None
    assert embed_client.calls == ["user-a"]
