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
