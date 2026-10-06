import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from app.canonical.model import (
    Block,
    BlockKind,
    CanonicalDoc,
    Document,
    DocumentFormat,
    SourceRef,
    Table,
    TableCell,
)
from app.canonical.stats import compute_doc_stats
from app.leveling.document_map import build_document_map, subtree_inputs_for_doc
from app.leveling.narration_publisher import LevelingProgress
from app.leveling.stage_units import units_from_progress

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "shared" / "schemas" / "job-live.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _validator(definition: str) -> Draft7Validator:
    return Draft7Validator(
        {
            "$schema": SCHEMA["$schema"],
            "definitions": SCHEMA["definitions"],
            "$ref": f"#/definitions/{definition}",
        }
    )


def _assert_valid(definition: str, payload: dict) -> None:
    errors = sorted(_validator(definition).iter_errors(payload), key=lambda e: list(e.path))
    assert not errors, [f"{list(e.path)}: {e.message}" for e in errors]


def _assert_invalid(definition: str, payload: dict) -> None:
    assert list(_validator(definition).iter_errors(payload)), "payload should have been rejected"


def _sr(i: int) -> SourceRef:
    return SourceRef(document_path="x.docx", start_offset=i, end_offset=i + 1)


def _heading_doc() -> CanonicalDoc:
    headings = [
        (1, "1  Power"), (2, "1.1  Bus voltage"),
        (3, "1.1.1  The system shall limit ripple."),
        (3, "1.1.2  The system shall report faults."),
    ]
    return CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"),
        blocks=[
            Block(id=f"h{i}", kind=BlockKind.HEADING, heading_level=lv, text=t, source_ref=_sr(i))
            for i, (lv, t) in enumerate(headings)
        ],
    )


def _table_doc() -> CanonicalDoc:
    rows = [
        ["ID", "Text"], ["1.1", "Detection"], ["1.1.1", "The system shall detect it."],
        ["1.1.2", "The system shall react."],
    ]
    table = Table(id="t1", cells=[[TableCell(text=c) for c in r] for r in rows], source_ref=_sr(0))
    return CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"), tables=[table]
    )


def _empty_doc() -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="x"),
        blocks=[Block(id="p", kind=BlockKind.PARAGRAPH, text="hello world", source_ref=_sr(0))],
    )


def test_the_schema_is_itself_a_valid_draft7_schema() -> None:
    Draft7Validator.check_schema(SCHEMA)


@pytest.mark.parametrize("make_doc", [_heading_doc, _table_doc, _empty_doc])
def test_every_document_map_the_backend_builds_conforms(make_doc) -> None:  # noqa: ANN001
    doc = make_doc()
    doc_map = build_document_map(compute_doc_stats(doc), subtree_inputs_for_doc(doc))
    _assert_valid("DocumentMap", doc_map.to_dict())


def _p(phase: str, **kwargs) -> LevelingProgress:  # noqa: ANN003
    base = dict(
        branch_index=None, branch_count=0, blocks_done=0, blocks_total=0,
        kb_grounded=False, kb_citations=[],
    )
    base.update(kwargs)
    return LevelingProgress(phase=phase, **base)  # type: ignore[arg-type]


STAGE_UNIT_SAMPLES = [
    _p("describe_figure", figure_index=2, figure_count=9),
    _p("parse_done", figure_count=9),
    _p("build_skeleton", branch_index=0, branch_count=3),
    _p("analyze_section", branch_index=1, branch_count=3),
    _p("section_complete", branch_index=1, branch_count=3),
    _p("map_scope"),
    _p("score_requirements", blocks_done=2, blocks_total=5),
    _p("score_requirements_done", blocks_total=5),
    _p("detect_conflicts"),
    _p("regroup_roots"),
    _p("infer_trace_links"),
]


@pytest.mark.parametrize("event", STAGE_UNIT_SAMPLES, ids=[e.phase for e in STAGE_UNIT_SAMPLES])
def test_every_stage_units_payload_the_backend_publishes_conforms(event) -> None:  # noqa: ANN001
    units = units_from_progress(event)
    assert units is not None
    _assert_valid("StageUnits", units.to_payload())


def test_progress_event_accepts_a_valid_frame_and_rejects_bad_ones() -> None:
    good = {
        "type": "progress", "seq": 4, "pct": 42, "stage": "draft", "unit": "items",
        "done": 150, "total": 275, "estimated": True, "emittedAt": "2026-10-05T10:00:00Z",
    }
    _assert_valid("ProgressEvent", good)
    _assert_invalid("ProgressEvent", {**good, "pct": 101})
    _assert_invalid("ProgressEvent", {**good, "pct": -1})
    _assert_invalid("ProgressEvent", {**good, "stage": "nonsense"})
    _assert_invalid("ProgressEvent", {k: v for k, v in good.items() if k != "seq"})
    _assert_invalid("ProgressEvent", {**good, "extra": 1})


def test_live_frame_accepts_valid_frames_and_enforces_the_text_caps() -> None:
    base = {
        "type": "live", "seq": 1, "lane": 0, "kind": "writing",
        "emittedAt": "2026-10-05T10:00:00Z",
    }
    writing = {
        "ref": "s0.4", "title": "Limit ripple", "itemType": "Requirement",
        "excerpt": "The BP shall provide power.", "cursor": 0.4, "partial": True,
    }
    _assert_valid("LiveFrame", {**base, **writing})
    conflict = {
        "kind": "conflict", "similarity": 0.93,
        "a": {"ref": "r1", "text": "Ripple is 50 mV."},
        "b": {"ref": "r2", "text": "Ripple is 30 mV."},
    }
    _assert_valid("LiveFrame", {**base, "kind": "compare", "compare": conflict})
    _assert_valid("LiveFrame", {**base, "kind": "ocr_page", "page": 3, "pages": 48})
    _assert_valid("LiveFrame", {**base, "kind": "reset"})
    _assert_invalid("LiveFrame", {**base, "excerpt": "x" * 1001})
    _assert_invalid("LiveFrame", {**base, "cursor": 1.5})
    _assert_invalid("LiveFrame", {**base, "kind": "invented"})
    too_long = {
        "kind": "duplicate", "similarity": 0.5,
        "a": {"ref": "r1", "text": "x" * 401}, "b": {"ref": "r2", "text": "ok"},
    }
    _assert_invalid("LiveFrame", {**base, "compare": too_long})


def test_the_stage_names_the_backend_produces_are_all_in_the_schema() -> None:
    allowed = set(SCHEMA["definitions"]["StageName"]["enum"])
    produced = {units_from_progress(e).stage for e in STAGE_UNIT_SAMPLES}
    assert produced <= allowed


def test_heartbeat_accepts_what_the_event_stream_sends_and_rejects_bad_shapes() -> None:
    quiet = {"type": "heartbeat", "at": "2026-10-05T10:00:00Z", "idleSeconds": 0, "inFlight": []}
    _assert_valid("Heartbeat", quiet)
    busy = {
        **quiet, "idleSeconds": 42,
        "inFlight": [
            {"lane": 0, "kind": "working_on", "ref": "r1", "title": "Power"},
            {"lane": 1, "kind": "ocr_page", "ref": None, "title": None},
        ],
    }
    _assert_valid("Heartbeat", busy)
    _assert_invalid("Heartbeat", {**quiet, "idleSeconds": -1})
    _assert_invalid("Heartbeat", {**quiet, "inFlight": [{"lane": 0, "kind": "item"}]})
    leaky = {"lane": 0, "kind": "writing", "excerpt": "x"}
    _assert_invalid("Heartbeat", {**quiet, "inFlight": [leaky]})
    _assert_invalid("Heartbeat", {**quiet, "extra": 1})


def test_stage_counter_payloads_conform_and_use_known_stage_names() -> None:
    from app.leveling.stage_units import StageCounter

    published: list[dict] = []

    class _Redis:
        def publish(self, channel, message):  # noqa: ANN001, ANN201
            published.append(json.loads(message))

        def hset(self, name, key, value):  # noqa: ANN001, ANN201
            return 1

        def expire(self, name, time):  # noqa: ANN001, ANN201
            return True

    counter = StageCounter(_Redis(), "job-c", clock=lambda: 0.0)
    counter.plan({"draft": 0, "improve": 36, "summarize": 12})
    counter.advance("improve", 10)
    counter.complete("summarize")
    allowed = set(SCHEMA["definitions"]["StageName"]["enum"])
    assert {p["stage"] for p in published} == {"draft", "improve", "summarize"}
    for payload in published:
        assert payload["stage"] in allowed
        _assert_valid("StageUnits", payload)


def test_notice_accepts_what_the_publisher_sends_and_rejects_free_text_shapes() -> None:
    from app.leveling.notices import NoticePublisher

    class Capture:
        def __init__(self) -> None:
            self.bodies: list[str] = []

        def rpush(self, *a): ...
        def ltrim(self, *a): ...
        def expire(self, *a): ...

        def publish(self, _channel, message):
            self.bodies.append(message)

    capture = Capture()
    NoticePublisher(capture, "j1").publish("output_limit_reached", "warning", step="analyze", lastRef="det0_1")
    sent = json.loads(capture.bodies[0])
    _assert_valid("Notice", sent)
    _assert_invalid("Notice", {**sent, "kind": "anything_else"})
    _assert_invalid("Notice", {**sent, "severity": "fatal"})
    _assert_invalid("Notice", {**sent, "count": 0})
    _assert_invalid("Notice", {**sent, "facts": {"text": "x" * 41}})
    _assert_invalid("Notice", {**sent, "facts": {"doc": {"a": 1}}})
    _assert_invalid("Notice", {**sent, "extra": 1})
