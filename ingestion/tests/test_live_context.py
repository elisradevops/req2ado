import json
import threading

import pytest

from app.canonical.model import SourceRef
from app.leveling import live_context
from app.leveling.conflict_detection import _detect_conflicting_duplicates
from app.leveling.live_context import (
    current_live_emitter,
    live_emitter_for,
    live_emitter_scope,
)
from app.logging_context import job_id_scope
from app.workitem.model import WorkItemMode, WorkItemNode, WorkItemType


class FakeRedis:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.counter = 0
        self.published: list[dict] = []

    def incr(self, name: str) -> int:
        with self.lock:
            self.counter += 1
            return self.counter

    def expire(self, name: str, time: int) -> None:
        pass

    def hset(self, name: str, key: str, value: str) -> None:
        pass

    def publish(self, channel: str, message: str) -> None:
        self.published.append(json.loads(message))


@pytest.fixture(autouse=True)
def _clean_registry():
    yield
    live_context._EMITTERS.clear()


def _flag(monkeypatch, on: bool) -> None:  # noqa: ANN001
    monkeypatch.setattr(live_context.settings, "live_progress", on)


def test_scope_yields_no_emitter_when_the_feature_is_off(monkeypatch) -> None:
    _flag(monkeypatch, False)
    with live_emitter_scope("job-1", FakeRedis()) as emitter:
        assert emitter is None
        assert live_emitter_for("job-1") is None


def test_scope_yields_no_emitter_without_a_job_id(monkeypatch) -> None:
    _flag(monkeypatch, True)
    with live_emitter_scope(None, FakeRedis()) as emitter:
        assert emitter is None


def test_scope_registers_the_emitter_and_removes_it_on_exit(monkeypatch) -> None:
    _flag(monkeypatch, True)
    with live_emitter_scope("job-1", FakeRedis()) as emitter:
        assert emitter is not None
        assert live_emitter_for("job-1") is emitter
    assert live_emitter_for("job-1") is None


def test_scope_flushes_waiting_frames_on_exit(monkeypatch) -> None:
    _flag(monkeypatch, True)
    redis = FakeRedis()
    with live_emitter_scope("job-1", redis) as emitter:
        for i in range(10):  # more than one burst at the default rate
            emitter.item(ref=f"r{i}", title="x")
        assert len(redis.published) < 10
    assert [f["ref"] for f in redis.published] == [f"r{i}" for i in range(10)]


def test_scope_cleans_up_even_when_the_job_fails(monkeypatch) -> None:
    _flag(monkeypatch, True)
    with pytest.raises(RuntimeError):
        with live_emitter_scope("job-1", FakeRedis()):
            raise RuntimeError("job failed")
    assert live_emitter_for("job-1") is None


def test_scope_survives_a_failure_to_build_the_emitter(monkeypatch) -> None:
    _flag(monkeypatch, True)

    def boom(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise RuntimeError("cannot build")

    monkeypatch.setattr(live_context, "LiveEmitter", boom)
    with live_emitter_scope("job-1", FakeRedis()) as emitter:
        assert emitter is None


def test_current_emitter_follows_the_job_in_scope(monkeypatch) -> None:
    _flag(monkeypatch, True)
    assert current_live_emitter() is None
    with live_emitter_scope("job-1", FakeRedis()) as emitter, job_id_scope("job-1"):
        assert current_live_emitter() is emitter
    with job_id_scope("job-2"):
        assert current_live_emitter() is None


def test_two_jobs_never_see_each_others_emitter(monkeypatch) -> None:
    _flag(monkeypatch, True)
    scope_one = live_emitter_scope("job-1", FakeRedis())
    scope_two = live_emitter_scope("job-2", FakeRedis())
    with scope_one as one, scope_two as two:
        assert one is not two
        assert live_emitter_for("job-1") is one
        assert live_emitter_for("job-2") is two


def test_a_worker_thread_finds_the_emitter_by_job_id(monkeypatch) -> None:
    _flag(monkeypatch, True)
    found: list[object] = []
    with live_emitter_scope("job-1", FakeRedis()) as emitter:
        thread = threading.Thread(target=lambda: found.append(live_emitter_for("job-1")))
        thread.start()
        thread.join()
    assert found == [emitter]


# ---- conflict detection emits a side-by-side comparison --------------------

class EmbedClient:
    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self._vectors = vectors

    def embed(self, texts: list[str], user_id: str | None = None) -> list[list[float]]:
        return [self._vectors[t] for t in texts]


class ConflictClient:
    def __init__(self, verdict: dict) -> None:
        self._verdict = verdict

    def judge_duplicate_cluster(
        self, texts_by_id: dict[str, str], user_id: str | None = None,
    ) -> dict:
        return self._verdict


def _req(local_id: str, text: str) -> WorkItemNode:
    return WorkItemNode(
        local_id=local_id, type=WorkItemType.REQUIREMENT, parent_local_id=None,
        title=text[:60], description=text,
        source_ref=SourceRef(document_path="x.docx", start_offset=0, end_offset=1),
        mode=WorkItemMode.SURVEY,
    )


TEXT_A = "Power-supply efficiency shall be at least 85%."
TEXT_B = "Power-supply efficiency shall be at-least 93%."


def _detect(verdict: dict) -> None:
    nodes = [_req("n0", TEXT_A), _req("n1", TEXT_B)]
    embed = EmbedClient({TEXT_A: [1.0, 0.0], TEXT_B: [0.99, 0.01]})
    _detect_conflicting_duplicates(nodes, embed, ConflictClient(verdict), [])


def test_a_confirmed_conflict_emits_a_compare_frame_with_both_texts(monkeypatch) -> None:
    _flag(monkeypatch, True)
    redis = FakeRedis()
    with live_emitter_scope("job-1", redis), job_id_scope("job-1"):
        _detect({"verdict": "contradictory", "conflicting_values": ["85%", "93%"]})
    compare = [f for f in redis.published if f["kind"] == "compare"]
    assert len(compare) == 1
    payload = compare[0]["compare"]
    assert payload["kind"] == "conflict"
    assert (payload["a"]["ref"], payload["a"]["text"]) == ("n0", TEXT_A)
    assert (payload["b"]["ref"], payload["b"]["text"]) == ("n1", TEXT_B)
    assert 0.9 < payload["similarity"] <= 1.0


def test_a_redundant_verdict_emits_nothing(monkeypatch) -> None:
    _flag(monkeypatch, True)
    redis = FakeRedis()
    with live_emitter_scope("job-1", redis), job_id_scope("job-1"):
        _detect({"verdict": "redundant", "conflicting_values": []})
    assert redis.published == []


def test_without_an_emitter_in_scope_conflict_detection_is_unchanged(monkeypatch) -> None:
    _flag(monkeypatch, False)
    redis = FakeRedis()
    with live_emitter_scope("job-1", redis), job_id_scope("job-1"):
        _detect({"verdict": "contradictory", "conflicting_values": ["85%", "93%"]})
    assert redis.published == []


class _UnitsRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []
        self.hashes: dict[str, dict[str, str]] = {}
        self._seq = 0

    def incr(self, name):  # noqa: ANN001, ANN201
        self._seq += 1
        return self._seq

    def expire(self, name, time):  # noqa: ANN001, ANN201
        return True

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        self.hashes.setdefault(name, {})[key] = value

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        self.published.append((channel, message))


def test_ocr_progress_callback_is_none_when_live_progress_is_off(monkeypatch) -> None:  # noqa: ANN001
    from app.leveling.live_context import ocr_progress_callback

    monkeypatch.setattr(live_context.settings, "live_progress", False)
    assert ocr_progress_callback("job-1", _UnitsRedis()) is None


def test_ocr_progress_callback_is_none_without_a_job_id(monkeypatch) -> None:  # noqa: ANN001
    from app.leveling.live_context import ocr_progress_callback

    monkeypatch.setattr(live_context.settings, "live_progress", True)
    assert ocr_progress_callback(None, _UnitsRedis()) is None


def test_ocr_progress_callback_publishes_page_units_and_a_live_frame(monkeypatch) -> None:  # noqa: ANN001
    import json

    from app.leveling.live_context import live_emitter_scope, ocr_progress_callback

    monkeypatch.setattr(live_context.settings, "live_progress", True)
    redis = _UnitsRedis()
    callback = ocr_progress_callback("job-ocr", redis)
    assert callback is not None

    with live_emitter_scope("job-ocr", redis):
        callback(2, 3, 4, 10, "recognised words on page four")

    units = [json.loads(m) for c, m in redis.published if c.endswith(":units")]
    assert units and units[0]["stage"] == "parse" and units[0]["unit"] == "pages"
    assert (units[0]["done"], units[0]["total"]) == (2, 3)
    frames = [json.loads(m) for c, m in redis.published if c.endswith(":live")]
    assert len(frames) == 1
    assert frames[0]["kind"] == "ocr_page" and frames[0]["page"] == 4 and frames[0]["pages"] == 10
    assert frames[0]["excerpt"] == "recognised words on page four"
