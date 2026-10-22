"""The reads of a KB document (every window, EXTRACTION_RUNS times) overlap instead of queueing.

A fresh profile build made runs x windows model calls one after another: 732 s inside a job when the proxy stalled half its calls for a
minute. They now run up to KB_PROFILE_CONCURRENCY at a time; the answers are merged in the order the calls were made, so the profile is
the one the sequential build gives."""
import threading
import time

import pytest

from app.config import settings
from app.kb import profile as profile_module
from app.kb.profile import InMemoryProfileStore, build_profile
from tests.test_kb_profile import FakeProfileClient

WINDOWS = ["w0", "w1", "w2"]
DELAYS = {"w0": 0.15, "w1": 0.08, "w2": 0.01}  # the first window finishes last


@pytest.fixture(autouse=True)
def three_windows_three_runs(monkeypatch):
    monkeypatch.setattr(profile_module, "EXTRACTION_RUNS", 3)
    monkeypatch.setattr(profile_module, "windows_of", lambda text, *a, **k: list(WINDOWS))


class SlowClient(FakeProfileClient):
    def __init__(self, fail_on: str | None = None) -> None:
        super().__init__()
        self.fail_on, self._lock, self.in_flight, self.max_in_flight = fail_on, threading.Lock(), 0, 0

    def extract_kb_document_profile(self, name, window_text, user_id=None):
        with self._lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            threading.Event().wait(DELAYS[window_text])
            if window_text == self.fail_on:
                raise RuntimeError("upstream 502")
            return {"categories": [{"name": f"Quality of {window_text}", "pass_condition": f"holds in {window_text}"}], "rules": [],
                    "type_definitions": [], "glossary": []}
        finally:
            with self._lock:
                self.in_flight -= 1


TEXT = {"A.pptx": "text of the document"}


def build(concurrency: int, client: SlowClient, monkeypatch):
    monkeypatch.setattr(settings, "kb_profile_concurrency", concurrency)
    started = time.monotonic()
    profile = build_profile(TEXT, client, model="m1")
    return profile, time.monotonic() - started


def test_calls_overlap_up_to_the_configured_number_and_the_build_is_faster(monkeypatch) -> None:
    sequential_client, parallel_client = SlowClient(), SlowClient()
    _, sequential = build(1, sequential_client, monkeypatch)
    _, parallel = build(3, parallel_client, monkeypatch)
    assert sequential_client.max_in_flight == 1
    assert parallel_client.max_in_flight == 3
    assert parallel < sequential * 0.6


def test_the_profile_is_the_one_the_sequential_build_gives_even_when_calls_finish_in_another_order(monkeypatch) -> None:
    one, _ = build(1, SlowClient(), monkeypatch)
    three, _ = build(3, SlowClient(), monkeypatch)
    assert [c.name for c in three.categories] == [c.name for c in one.categories]
    assert [(c.name, c.pass_condition, c.seen_in) for c in three.categories] == [(c.name, c.pass_condition, c.seen_in) for c in one.categories]
    assert three.version == one.version and three.docs == one.docs


def test_a_failing_call_is_one_error_of_its_window_and_the_rest_still_count(monkeypatch) -> None:
    profile, _ = build(3, SlowClient(fail_on="w1"), monkeypatch)
    assert profile.degraded is True
    assert sorted(c.name for c in profile.categories) == ["Quality of w0", "Quality of w2"]
    status = next(d for d in profile.docs if d.file == "A.pptx")
    assert status.status == "contributed" and "3 of 9 extraction calls failed" in (status.reason or "")


def test_a_cancelled_run_stops_asking_in_every_worker(monkeypatch) -> None:
    from app import job_cancel

    client = SlowClient()
    monkeypatch.setattr(settings, "kb_profile_concurrency", 3)
    with job_cancel.cancellation_scope() as token:
        token.cancel()
        original = client.extract_kb_document_profile

        def guarded(name, window_text, user_id=None):
            job_cancel.raise_if_cancelled()
            return original(name, window_text, user_id=user_id)

        client.extract_kb_document_profile = guarded
        profile = build_profile(TEXT, client, model="m1")
    assert client.max_in_flight == 0 and profile.degraded is True
