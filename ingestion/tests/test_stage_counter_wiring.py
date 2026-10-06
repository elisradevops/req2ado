"""The deterministic passes report exact item counts through the job's
StageCounter, only when live progress is on."""
import json

import pytest

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.leveling import live_context
from app.leveling.live_context import live_emitter_scope
from app.leveling.llm_leveling import _detect_deterministic_subtrees
from app.logging_context import job_id_scope

JOB = "job-count"


class FakeRedis:
    def __init__(self) -> None:
        self.units: list[dict] = []

    def incr(self, name):  # noqa: ANN001, ANN201
        return 1

    def expire(self, name, time):  # noqa: ANN001, ANN201
        return True

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        return 1

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        if channel.endswith(":units"):
            self.units.append(json.loads(message))

    def stage(self, name: str) -> list[dict]:
        return [u for u in self.units if u["stage"] == name]


class TitleTags:
    def title_and_tags_for_rows(self, texts, user_id=None):  # noqa: ANN001, ANN201
        return {k: {"title": f"T {k}", "tags": []} for k in texts}


class Synthesis:
    def synthesize_leaf_requirements(self, items, user_id=None):  # noqa: ANN001, ANN201
        return {k: {"title": "S", "text": v["text"], "tags": []} for k, v in items.items()}


class Parents:
    def summarize_parent_nodes(self, nodes, user_id=None):  # noqa: ANN001, ANN201
        return {k: {"title": "P", "description": "d"} for k in nodes}


def _doc() -> CanonicalDoc:
    headings = [
        (1, "1  Power"), (2, "1.1  Bus voltage"),
        (3, "1.1.1  The system shall limit ripple."), (3, "1.1.2  The system shall report faults."),
    ]
    return CanonicalDoc(
        document=Document(path="x.docx", format=DocumentFormat.DOCX, sha256="x"),
        blocks=[
            Block(id=f"h{i}", kind=BlockKind.HEADING, heading_level=level, text=text,
                  source_ref=SourceRef(document_path="x.docx", start_offset=i, end_offset=i + 1))
            for i, (level, text) in enumerate(headings)
        ],
    )


def _run(monkeypatch, *, live: bool, parents: bool = True):  # noqa: ANN001, ANN202
    monkeypatch.setattr(live_context.settings, "live_progress", live)
    redis = FakeRedis()
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        _detect_deterministic_subtrees(
            _doc(), TitleTags(), Synthesis(), Parents() if parents else None,
        )
    return redis


def test_the_plan_comes_first_and_a_pass_with_nothing_to_do_reads_as_skipped(
    monkeypatch,  # noqa: ANN001
) -> None:
    redis = _run(monkeypatch, live=True)
    first = {u["stage"]: u for u in redis.units[:3]}
    assert set(first) == {"draft", "improve", "summarize"}
    # Nothing needs synthesis, so the draft pass is planned at zero and complete.
    assert (first["draft"]["total"], first["draft"]["complete"]) == (0, True)
    assert (first["improve"]["done"], first["improve"]["total"]) == (0, 2)
    assert first["summarize"]["total"] == 2


def test_every_pass_ends_with_its_exact_count_and_complete(monkeypatch) -> None:  # noqa: ANN001
    redis = _run(monkeypatch, live=True)
    improve = redis.stage("improve")
    assert [u["done"] for u in improve] == sorted(u["done"] for u in improve)
    assert improve[-1]["done"] == 2 and improve[-1]["complete"] is True
    summarize = redis.stage("summarize")
    last = summarize[-1]
    assert last["done"] == last["total"] == 2 and last["complete"] is True
    # The title/tag pass counted its finished chunk before the end-of-pass mark.
    assert any(u["done"] == 2 and not u["complete"] for u in improve)


def test_without_a_parent_summary_client_that_pass_is_planned_as_skipped(monkeypatch) -> None:  # noqa: ANN001
    redis = _run(monkeypatch, live=True, parents=False)
    summarize = redis.stage("summarize")
    assert summarize and all(u["total"] == 0 and u["complete"] for u in summarize)


def test_nothing_is_published_with_live_progress_off(monkeypatch) -> None:  # noqa: ANN001
    assert _run(monkeypatch, live=False).units == []


def test_a_failing_chunk_still_counts_as_finished(monkeypatch) -> None:  # noqa: ANN001
    class Boom:
        def title_and_tags_for_rows(self, texts, user_id=None):  # noqa: ANN001, ANN201
            raise RuntimeError("model down")

    monkeypatch.setattr(live_context.settings, "live_progress", True)
    redis = FakeRedis()
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        _detect_deterministic_subtrees(_doc(), Boom(), None, None)
    assert redis.stage("improve")[-1]["done"] == 2


@pytest.mark.parametrize("live", [True, False])
def test_the_built_nodes_do_not_depend_on_the_counter(monkeypatch, live) -> None:  # noqa: ANN001
    monkeypatch.setattr(live_context.settings, "live_progress", live)
    redis = FakeRedis()
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        nodes, _w, _doc2 = _detect_deterministic_subtrees(
            _doc(), TitleTags(), Synthesis(), Parents(),
        )
    assert [(n.local_id, n.title) for n in nodes] == [
        (n.local_id, n.title)
        for n in _detect_deterministic_subtrees(_doc(), TitleTags(), Synthesis(), Parents())[0]
    ]


def _plain_doc() -> CanonicalDoc:
    return CanonicalDoc(
        document=Document(path="x.pdf", format=DocumentFormat.PDF, sha256="x"),
        blocks=[
            Block(id="p0", kind=BlockKind.PARAGRAPH, text="The platform shall run on 28 V.",
                  source_ref=SourceRef(document_path="x.pdf", start_offset=0, end_offset=1)),
        ],
    )


def test_a_document_with_no_deterministic_subtrees_publishes_no_pass_units(
    monkeypatch,  # noqa: ANN001
) -> None:
    # A text PDF or a scan goes down the section path. A "summarize 0 of 0" marker
    # would make the progress calculation take it for a heading-structured document.
    monkeypatch.setattr(live_context.settings, "live_progress", True)
    redis = FakeRedis()
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        _detect_deterministic_subtrees(_plain_doc(), TitleTags(), Synthesis(), Parents())
    assert redis.units == []
