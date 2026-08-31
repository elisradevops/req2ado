"""Tests for /ingest's post-parse figure-captioning pass -- the bounded
concurrent phase that replaced inline, one-at-a-time vision calls during the
document walk.

Every test here uploads through the real route, so every one passes a UNIQUE
primer_context: _describe_figure's cache key includes it (see
_figure_caption_cache_key), and these tests run against a real, persistent
Redis, so a shared context would let one test read another's cached caption.
"""

import threading
import time
import uuid

import pytest

from app.vision.orchestrator_vision_client import FigureVisionResult
from tests.test_ingest_caption_status import FIXTURES, _upload

MULTI_FIGURE_FIXTURE_NAME = "multi_figure.docx"


def test_captioning_runs_figures_concurrently(monkeypatch) -> None:
    # Thread-name-cardinality idiom, copied from this repo's existing
    # concurrency proof (test_llm_leveling.py's
    # test_mapping_runs_branches_concurrently_at_the_same_parallelism_as_its_neighbours):
    # a sleep long enough that a serial run could only ever use one thread,
    # asserted on the number of DISTINCT thread names -- not on elapsed
    # time, which is flaky on a loaded CI box.
    import app.main as main_module

    seen: set[str] = set()
    lock = threading.Lock()

    class _ThreadRecordingVisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            with lock:
                seen.add(threading.current_thread().name)
            time.sleep(0.05)
            return FigureVisionResult(significant=True, description="a real caption")

    monkeypatch.setattr(main_module, "_vision_client", _ThreadRecordingVisionClient())
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", 4)

    _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        # uuid, not a fixed literal: the caption cache key is
        # (prompt version, image sha256, document_context sha256) with a
        # 7-day TTL against a real Redis, so a fixed context makes the SECOND
        # run of this test a pure cache hit -- no vision call, no threads, and
        # the concurrency assertion below would pass vacuously. Unique per
        # invocation keeps the test genuinely rerunnable.
        primer_context=f"captioning-concurrency-thread-names-{uuid.uuid4()}",
    )

    assert len(seen) > 1


def test_captioning_never_exceeds_the_configured_concurrency(monkeypatch) -> None:
    import app.main as main_module

    in_flight = 0
    max_in_flight = 0
    lock = threading.Lock()

    class _CountingVisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            nonlocal in_flight, max_in_flight
            with lock:
                in_flight += 1
                max_in_flight = max(max_in_flight, in_flight)
            time.sleep(0.05)
            with lock:
                in_flight -= 1
            return FigureVisionResult(significant=True, description="a real caption")

    monkeypatch.setattr(main_module, "_vision_client", _CountingVisionClient())
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", 2)

    _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        primer_context="captioning-concurrency-bounded",
    )

    assert max_in_flight <= 2


def test_captioning_output_is_identical_serial_vs_concurrent(monkeypatch) -> None:
    # Concurrency must never change WHAT the document ends up containing,
    # only how long it takes. Figure 0's vision call is deliberately delayed
    # so a later figure genuinely completes first.
    import hashlib

    import app.main as main_module

    class _OrderSensitiveVisionClient:
        def __init__(self) -> None:
            self._first_seen: bytes | None = None

        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            if self._first_seen is None:
                self._first_seen = image_bytes
            if image_bytes == self._first_seen:
                time.sleep(0.2)
            digest = hashlib.sha256(image_bytes).hexdigest()[:8]
            return FigureVisionResult(significant=True, description=f"caption for {digest}")

    def run(concurrency: int, context: str) -> tuple:
        monkeypatch.setattr(main_module, "_vision_client", _OrderSensitiveVisionClient())
        monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", concurrency)
        result = _upload(
            MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
            primer_context=context,
        )
        return (
            [(f["id"], f["caption"], f["name"], f["caption_status"]) for f in result["figures"]],
            [(b["id"], b["kind"], b["text"]) for b in result["blocks"]],
            result["failed_figure_storage_ids"],
        )

    # Distinct primer_contexts so neither run reads the other's cache; the
    # caption text itself is derived from the image bytes, so it is
    # comparable across the two runs regardless.
    assert run(1, "captioning-equivalence-serial") == run(4, "captioning-equivalence-concurrent")


def test_captioning_narrates_figures_in_document_order_under_concurrency(monkeypatch) -> None:
    # ProgressBanner derives its overall percentage from the LAST narration
    # event's figureIndex (completedUnits = latest.figureIndex), and there is
    # no timestamp or sequence field on the frontend's NarrationEvent at all
    # -- so an out-of-order figureIndex makes the progress bar move
    # backwards. Both the per-figure "starting" and "captioned" events must
    # arrive strictly ascending, regardless of completion order.
    import app.main as main_module

    published: list = []

    class _SlowFirstFigureVisionClient:
        def __init__(self) -> None:
            self._first_seen: bytes | None = None

        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            if self._first_seen is None:
                self._first_seen = image_bytes
            if image_bytes == self._first_seen:
                time.sleep(0.2)
            return FigureVisionResult(significant=True, description="a real caption")

    class _RecordingNarrationPublisher:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def publish(self, progress) -> None:
            published.append(progress)

    monkeypatch.setattr(main_module, "_vision_client", _SlowFirstFigureVisionClient())
    monkeypatch.setattr(main_module, "NarrationPublisher", _RecordingNarrationPublisher)
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", 4)

    _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        job_id="job-caption-narration-order", primer_context="captioning-narration-order",
    )

    figure_events = [e for e in published if e.phase == "describe_figure"]
    starts = [e.figure_index for e in figure_events if e.figure_caption is None]
    dones = [e.figure_index for e in figure_events if e.figure_caption is not None]
    assert starts == sorted(starts)
    assert dones == sorted(dones)
    assert starts == dones  # one start and one done per figure, same order


@pytest.mark.parametrize("concurrency", [1, 4])
def test_a_raising_vision_call_leaves_one_figure_uncaptioned(monkeypatch, concurrency) -> None:
    # Before captioning moved out of the parse walk, each loader's own
    # per-figure try/except swallowed anything the vision call raised (HTTP
    # 5xx via raise_for_status, a timeout, a malformed body) and the document
    # still ingested with that one figure uncaptioned. The post-parse pass
    # runs outside those loaders, so the same exception would otherwise
    # escape the worker and 500 the whole /ingest request. Both concurrency
    # branches are exercised: the bug was present in each.
    import app.main as main_module

    class _RaisingVisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            raise RuntimeError("vision service is down")

    monkeypatch.setattr(main_module, "_vision_client", _RaisingVisionClient())
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", concurrency)

    # _upload asserts HTTP 200 -- a propagated exception fails right here.
    result = _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        primer_context=f"captioning-vision-raises-{uuid.uuid4()}",
    )

    assert result["figures"]
    assert all(f["caption"] is None for f in result["figures"])
    assert all(f["caption_status"] == "vision_failed" for f in result["figures"])


@pytest.mark.parametrize("concurrency", [1, 4])
def test_figure_narration_stream_is_incremental_and_monotonic(monkeypatch, concurrency) -> None:
    # The user-visible property is about the SINGLE stream the frontend sees:
    # ProgressBanner reads completedUnits off the LAST narration event's
    # figureIndex and NarrationEvent carries no sequence field, so the
    # starting/captioned events INTERLEAVED must never move the index
    # backwards. Partitioning into starts and dones and sorting each (as the
    # sibling document-order test does) cannot see the real regression: firing
    # every start up front, or every done in one burst at the end, leaves both
    # partitions perfectly sorted while the combined stream reads
    # 1, 2, ..., N, 1, 2, ..., N -- a bar that jumps to 100% of the phase in
    # microseconds and then freezes for the whole pass.
    import app.main as main_module

    published: list = []

    class _SlowFirstFigureVisionClient:
        def __init__(self) -> None:
            self._first_seen: bytes | None = None

        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            if self._first_seen is None:
                self._first_seen = image_bytes
            if image_bytes == self._first_seen:
                time.sleep(0.2)
            return FigureVisionResult(significant=True, description="a real caption")

    class _RecordingNarrationPublisher:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def publish(self, progress) -> None:
            published.append(progress)

    monkeypatch.setattr(main_module, "_vision_client", _SlowFirstFigureVisionClient())
    monkeypatch.setattr(main_module, "NarrationPublisher", _RecordingNarrationPublisher)
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", concurrency)

    result = _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        job_id="job-caption-narration-monotonic",
        primer_context=f"captioning-narration-monotonic-{uuid.uuid4()}",
    )

    combined = [e.figure_index for e in published if e.phase == "describe_figure"]
    assert len(combined) == 2 * len(result["figures"])  # one start + one done per figure
    assert combined == sorted(combined), f"figure narration moved backwards: {combined}"
    # And each figure's own pair is adjacent -- i.e. the captioned event for
    # figure i arrives before figure i+1's starting event, which is what makes
    # the progress genuinely incremental rather than one final burst.
    assert combined == [i // 2 + 1 for i in range(len(combined))]


def test_storage_failures_are_recorded_in_figure_id_order_under_concurrency(monkeypatch) -> None:
    # failed_figure_storage_ids is surfaced on the response and turned into a
    # WarningRecord by the orchestrator, so its ORDER is user-visible and
    # must not depend on which worker happened to fail first.
    import app.main as main_module

    class _VisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            return FigureVisionResult(significant=True, description="a real caption")

    class _AlwaysFailingFigureFileClient:
        def store(self, job_id, figure_id, image_bytes, mime_type) -> None:
            # Fail the LAST figure fastest and the first slowest, so a
            # completion-ordered list would come back reversed.
            if figure_id == "f0":
                time.sleep(0.2)
            raise RuntimeError("storage is down")

    monkeypatch.setattr(main_module, "_vision_client", _VisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _AlwaysFailingFigureFileClient())
    monkeypatch.setattr(main_module, "compress_figure_for_storage", lambda b: (b, "image/png"))
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", 4)

    result = _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        job_id="job-storage-failure-order", primer_context="captioning-storage-failure-order",
    )

    failed = result["failed_figure_storage_ids"]
    assert failed == [f"f{i}" for i in range(len(result["figures"]))]


def test_figure_bytes_are_still_rasterized_exactly_once_per_figure_under_concurrency(monkeypatch) -> None:
    # The rasterized-bytes-reuse fix (a prior SWEEP 8b item) must survive the
    # restructuring: captioning and storage stay in ONE worker, sharing one
    # caption_status_out["rasterized_bytes"], so there is still exactly one
    # _rasterize_for_vision call per figure.
    import app.main as main_module

    class _VisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            return FigureVisionResult(significant=True, description="a real caption")

    class _FigureFileClient:
        def store(self, job_id, figure_id, image_bytes, mime_type) -> None:
            return None

    rasterize_calls: list[bytes] = []
    original_rasterize = main_module._rasterize_for_vision
    lock = threading.Lock()

    def counting_rasterize(image_bytes: bytes):
        with lock:
            rasterize_calls.append(image_bytes)
        return original_rasterize(image_bytes)

    monkeypatch.setattr(main_module, "_vision_client", _VisionClient())
    monkeypatch.setattr(main_module, "_figure_file_client", _FigureFileClient())
    monkeypatch.setattr(main_module, "_rasterize_for_vision", counting_rasterize)
    monkeypatch.setattr(main_module, "compress_figure_for_storage", lambda b: (b, "image/png"))
    monkeypatch.setattr(main_module.settings, "vision_caption_concurrency", 4)

    result = _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        job_id="job-rasterize-once-concurrent", primer_context="captioning-rasterize-once-concurrent",
    )

    assert len(rasterize_calls) == len(result["figures"])


def test_figure_count_narration_is_the_exact_collected_count(monkeypatch) -> None:
    # The two-phase split makes the denominator exact for EVERY format:
    # figure_count is now len(collected bytes) rather than a per-format
    # precount that was exact for docx/pptx, hardcoded 1 for images, and
    # explicitly approximate for pdf.
    import app.main as main_module

    published: list = []

    class _VisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            return FigureVisionResult(significant=True, description="a real caption")

    class _RecordingNarrationPublisher:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def publish(self, progress) -> None:
            published.append(progress)

    monkeypatch.setattr(main_module, "_vision_client", _VisionClient())
    monkeypatch.setattr(main_module, "NarrationPublisher", _RecordingNarrationPublisher)

    result = _upload(
        MULTI_FIGURE_FIXTURE_NAME, FIXTURES / MULTI_FIGURE_FIXTURE_NAME, mode="survey",
        job_id="job-exact-figure-count", primer_context="captioning-exact-figure-count",
    )

    real_count = len(result["figures"])
    figure_events = [e for e in published if e.phase == "describe_figure"]
    assert figure_events
    assert all(e.figure_count == real_count for e in figure_events)


def test_a_vision_active_docx_is_parsed_exactly_once(monkeypatch) -> None:
    # The docx/pptx figure-precount pass was a SECOND full document walk,
    # needed only because the figure total wasn't knowable during inline
    # captioning. With captioning moved after parsing it is redundant, and
    # deleting it means a vision-active docx is dispatched exactly once.
    import app.main as main_module

    dispatch_calls: list[str] = []
    original_dispatch = main_module.dispatch_by_extension

    def counting_dispatch(filename, path, **kwargs):
        dispatch_calls.append(filename)
        return original_dispatch(filename, path, **kwargs)

    class _VisionClient:
        def describe_figure(self, image_bytes, mime_type=None, document_context=None):
            return FigureVisionResult(significant=True, description="a real caption")

    monkeypatch.setattr(main_module, "dispatch_by_extension", counting_dispatch)
    monkeypatch.setattr(main_module, "_vision_client", _VisionClient())

    _upload(
        "sample.docx", FIXTURES / "sample.docx", mode="survey",
        job_id="job-single-parse", primer_context="captioning-single-parse",
    )

    assert len(dispatch_calls) == 1
