"""Several drafting chunks in flight at once (survey_chunk_concurrency > 1), streamed.

The real builder and the real client run against a fake orchestrator that answers slowly
enough for the chunks to overlap. With streaming off and on the finished tree must be
identical; with it on, each concurrent call has a lane of its own, sequence numbers never
repeat or go backwards, and every finished item is delivered exactly once."""
import json
import threading
import time

import httpx

from app.canonical.model import SourceRef
from app.leveling.id_hierarchy import HierarchyRow
from app.leveling.id_tree_builder import build_hierarchy_subtree
from app.leveling.live_context import live_emitter_scope
from app.logging_context import job_id_scope
from app.survey import orchestrator_llm_client as client_module
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

JOB = "job-conc"
REQUIREMENTS = 400  # about three title/tag chunks of up to 150, plus one synthesis chunk


class LockedRedis:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.frames: list[dict] = []
        self._seq = 0

    def incr(self, name):  # noqa: ANN001, ANN201
        with self.lock:
            self._seq += 1
            return self._seq

    def expire(self, name, time):  # noqa: ANN001, ANN201
        return True

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        return 1

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        if channel.endswith(":live"):
            with self.lock:
                self.frames.append(json.loads(message))


class Server:
    """Answers every call after a short pause and records how many were in flight together."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0

    def answer(self, payload: dict) -> str:
        name = payload["responseSchema"]["name"]
        given = json.loads(payload["messages"][1]["content"])
        if name == "title_tags_by_row":
            return json.dumps(
                {k: {"title": f"T {v[:14]}", "tags": ["safety"]} for k, v in given.items()}
            )
        if name == "synthesized_requirements_by_row":
            return json.dumps({
                k: {
                    "title": f"S {v['text'][:10]}",
                    "text": f"The system shall {v['text']}.",
                    "tags": [],
                }
                for k, v in given.items()
            })
        raise AssertionError(name)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self.lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            time.sleep(0.15)  # long enough for the other chunks to start
            content = self.answer(json.loads(request.content))
        finally:
            with self.lock:
                self.in_flight -= 1
        if request.url.path == "/llm/chat":
            return httpx.Response(200, json={"content": content})
        lines = [
            json.dumps({"delta": content[i : i + 40]}) for i in range(0, len(content), 40)
        ]
        lines.append(json.dumps({"done": True, "finishReason": "stop"}))
        return httpx.Response(200, content=("\n".join(lines) + "\n").encode())


def _rows() -> list[HierarchyRow]:
    def sr(i: int) -> SourceRef:
        return SourceRef(document_path="x.docx", start_offset=i, end_offset=i + 1)

    def row(label, node_type, parent, id_text, synth=False):  # noqa: ANN001, ANN202
        return HierarchyRow(
            label=label, has_shall=node_type == "Requirement",
            source_ref=sr(hash(id_text) % 10_000),
            node_type=node_type, parent_index=parent, id_text=id_text,
            id_disambiguator_needed=False,
            needs_synthesis=synth, id_text_is_authored=True,
        )

    rows = [row("Power", "Epic", None, "1"), row("Input", "Feature", 0, "1.1")]
    for i in range(REQUIREMENTS):
        rows.append(
            row(f"Item {i}: input range {i} V", "Requirement", 1, f"1.1.{i + 1}", synth=i % 5 == 0)
        )
    return rows


def _build(monkeypatch, *, stream: bool):  # noqa: ANN001, ANN202
    monkeypatch.setattr(client_module.settings, "live_progress", stream)
    monkeypatch.setattr(client_module.settings, "llm_stream_drafting", stream)
    server, redis = Server(), LockedRedis()
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(server)
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        nodes, warnings = build_hierarchy_subtree(
            _rows(), "det0_", client, synthesis_client=client, user_id="u1", chunk_concurrency=3,
        )
    tree = (
        [n.model_dump(mode="json") for n in nodes],
        [w.model_dump(mode="json") for w in warnings],
    )
    return tree, server, redis


def test_chunks_overlapped_and_the_tree_is_identical_with_streaming_off_and_on(
    monkeypatch,  # noqa: ANN001
) -> None:
    off_tree, off_server, off_redis = _build(monkeypatch, stream=False)
    on_tree, on_server, on_redis = _build(monkeypatch, stream=True)

    # The test is really concurrent.
    assert off_server.max_in_flight >= 2 and on_server.max_in_flight >= 2
    assert on_tree == off_tree
    assert off_redis.frames == []


def test_each_concurrent_call_gets_its_own_lane_and_sequence_numbers_never_repeat(
    monkeypatch,  # noqa: ANN001
) -> None:
    _tree, server, redis = _build(monkeypatch, stream=True)

    frames = redis.frames
    seqs = [f["seq"] for f in frames]
    assert len(seqs) == len(set(seqs)), "a sequence number was used twice"
    lanes = {f["lane"] for f in frames}
    assert len(lanes) >= 2 and lanes <= set(range(server.max_in_flight + 1))
    # Within one lane, frames never go backwards.
    for lane in lanes:
        lane_seqs = [f["seq"] for f in frames if f["lane"] == lane]
        assert lane_seqs == sorted(lane_seqs)


def test_every_finished_item_is_delivered_exactly_once_across_the_lanes(
    monkeypatch,  # noqa: ANN001
) -> None:
    _tree, _server, redis = _build(monkeypatch, stream=True)

    items = [f["ref"] for f in redis.frames if f["kind"] == "item"]
    assert len(items) == len(set(items)) == REQUIREMENTS
    # Each lane ends cleared, so none replays as "working" after the run.
    last_by_lane: dict[int, str] = {}
    for f in redis.frames:
        last_by_lane[f["lane"]] = f["kind"]
    assert set(last_by_lane.values()) == {"reset"}
