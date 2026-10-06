import json

import pytest

from app.leveling import narration_publisher as np_module
from app.leveling.narration_publisher import LevelingProgress, NarrationPublisher
from app.leveling.stage_units import (
    publish_stage_units,
    units_channel,
    units_from_progress,
    units_latest_key,
)


def _p(phase: str, **kwargs) -> LevelingProgress:  # noqa: ANN003
    base = dict(
        branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
        kb_grounded=False, kb_citations=[],
    )
    base.update(kwargs)
    return LevelingProgress(phase=phase, **base)  # type: ignore[arg-type]


def test_figure_in_flight_is_not_yet_done() -> None:
    units = units_from_progress(_p("describe_figure", figure_index=3, figure_count=35))
    assert (units.stage, units.unit, units.done, units.total) == ("parse", "figures", 2, 35)


def test_figure_with_caption_is_done() -> None:
    units = units_from_progress(
        _p("describe_figure", figure_index=3, figure_count=35, figure_caption="a diagram")
    )
    assert units.done == 3


def test_figure_without_a_known_total_has_no_units() -> None:
    assert units_from_progress(_p("describe_figure", figure_index=3)) is None


def test_parse_done_completes_the_parse_stage() -> None:
    units = units_from_progress(_p("parse_done", figure_count=35, block_count=412))
    assert (units.stage, units.done, units.total, units.complete) == ("parse", 35, 35, True)


def test_parse_done_for_a_document_without_figures_is_complete_at_zero() -> None:
    units = units_from_progress(_p("parse_done"))
    assert (units.done, units.total, units.complete) == (0, 0, True)


@pytest.mark.parametrize(
    "label",
    [
        "Heading hierarchy -- synthesizing requirement text for 150 node(s) (chunk 2 of 2)",
        "Heading hierarchy -- enhancing titles/tags for 3 node(s) (chunk 2 of 2)",
    ],
)
def test_pass_narration_counts_nothing_the_stage_counter_owns_those_units(label: str) -> None:
    # draft / improve / summarize are summed across chunks and subtrees by
    # StageCounter; one subtree's start-of-chunk position must not fight it.
    assert units_from_progress(
        _p("deterministic_subtree", blocks_done=150, blocks_total=275, subtree_label=label)
    ) is None


def test_subtree_kickoff_without_a_pass_has_no_units() -> None:
    assert units_from_progress(
        _p(
            "deterministic_subtree", subtree_index=0, subtree_count=1,
            subtree_label="Heading hierarchy",
        )
    ) is None


def test_done_is_clamped_to_the_total() -> None:
    units = units_from_progress(_p("score_requirements", blocks_done=99, blocks_total=10))
    assert units.done == 10


@pytest.mark.parametrize(
    "phase,stage,done",
    [
        ("build_skeleton", "skeleton", 3),
        ("analyze_section", "write", 3),
        ("section_complete", "write", 4),
    ],
)
def test_section_path_phases_count_sections(phase: str, stage: str, done: int) -> None:
    units = units_from_progress(_p(phase, branch_index=3, branch_count=9))
    assert (units.stage, units.unit, units.done, units.total) == (stage, "sections", done, 9)


def test_section_phase_without_a_branch_has_no_units() -> None:
    assert units_from_progress(_p("analyze_section", branch_count=9)) is None


def test_mapping_pass_is_a_single_unit_that_holds() -> None:
    units = units_from_progress(_p("map_scope"))
    assert (units.stage, units.done, units.total) == ("map", 0, 1)


def test_scoring_counts_requirements_and_completes() -> None:
    mid = units_from_progress(_p("score_requirements", blocks_done=40, blocks_total=153))
    assert (mid.stage, mid.unit, mid.done, mid.total) == ("score", "requirements", 40, 153)
    done = units_from_progress(_p("score_requirements_done", blocks_done=40, blocks_total=153))
    assert done.done == 153


def test_whole_document_passes_count_passes_finished() -> None:
    got = [
        units_from_progress(_p(phase)).done
        for phase in ("detect_conflicts", "regroup_roots", "infer_trace_links")
    ]
    assert got == [0, 1, 2]
    assert units_from_progress(_p("detect_conflicts")).total == 3


@pytest.mark.parametrize(
    "phase",
    ["preparing_analysis", "table_detected", "page_alignment", "chunk_warning", "job_failed",
     "dedup_check"],
)
def test_other_phases_have_no_units(phase: str) -> None:
    assert units_from_progress(_p(phase)) is None


class _FakeRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []
        self.hashes: dict[str, dict[str, str]] = {}
        self.expires: list[tuple[str, int]] = []
        self.rpushed: list[str] = []

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        self.published.append((channel, json.loads(message)))

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        self.hashes.setdefault(name, {})[key] = value

    def expire(self, name, time):  # noqa: ANN001, ANN201
        self.expires.append((name, time))

    def rpush(self, name, value):  # noqa: ANN001, ANN201
        self.rpushed.append(value)

    def ltrim(self, name, start, end):  # noqa: ANN001, ANN201
        pass


def test_publish_sends_units_on_their_own_channel_and_keeps_the_latest() -> None:
    redis = _FakeRedis()
    event = _p("score_requirements", blocks_done=5, blocks_total=10)
    assert publish_stage_units(redis, "job-1", event)
    channel, payload = redis.published[0]
    assert channel == units_channel("job-1") == "job-events:job-1:units"
    assert payload["type"] == "units" and payload["stage"] == "score"
    assert json.loads(redis.hashes[units_latest_key("job-1")]["score"])["done"] == 5
    assert redis.expires and redis.expires[0][0] == units_latest_key("job-1")


def test_publish_does_nothing_for_an_event_without_units() -> None:
    redis = _FakeRedis()
    assert publish_stage_units(redis, "job-1", _p("preparing_analysis")) is False
    assert redis.published == []


def test_publish_never_raises_when_redis_is_down() -> None:
    class Broken:
        def hset(self, *a, **k):  # noqa: ANN002, ANN003, ANN201
            raise ConnectionError("down")

    assert publish_stage_units(Broken(), "job-1", _p("score_requirements", blocks_total=3)) is False


def _narrate(monkeypatch, flag: bool):  # noqa: ANN001, ANN202
    monkeypatch.setattr(np_module.settings, "live_progress", flag)
    redis = _FakeRedis()
    publisher = NarrationPublisher(redis, "job-1")
    publisher.publish(_p("score_requirements", blocks_done=5, blocks_total=10))
    return redis


def test_flag_off_publishes_no_units(monkeypatch) -> None:
    redis = _narrate(monkeypatch, False)
    assert [c for c, _ in redis.published] == ["job-events:job-1"]
    assert redis.hashes == {}


def test_flag_on_adds_units_without_touching_the_browser_channel(monkeypatch) -> None:
    off = _narrate(monkeypatch, False)
    on = _narrate(monkeypatch, True)
    browser_off = [m for c, m in off.published if c == "job-events:job-1"]
    browser_on = [m for c, m in on.published if c == "job-events:job-1"]
    assert len(browser_on) == len(browser_off) == 1
    # Same narration payload either way (emittedAt differs by clock).
    browser_off[0].pop("emittedAt")
    browser_on[0].pop("emittedAt")
    assert browser_on[0] == browser_off[0]
    assert [c for c, _ in on.published] == ["job-events:job-1", "job-events:job-1:units"]
