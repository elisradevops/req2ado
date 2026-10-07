"""Stand-in for the golden end-to-end flags-off/flags-on comparison (which
needs Docker and a real chat model): the REAL deterministic tree builder is
driven by the REAL client against a fake orchestrator that answers both the
plain and the streaming endpoint with the same content. The finished tree must
be identical with streaming off and on."""
import json

import httpx

from app.canonical.model import SourceRef
from app.leveling.id_hierarchy import HierarchyRow
from app.leveling.id_tree_builder import build_hierarchy_subtree
from app.leveling.live_context import live_emitter_scope
from app.logging_context import job_id_scope
from app.survey import orchestrator_llm_client as client_module
from app.survey.orchestrator_llm_client import OrchestratorLlmClient

JOB = "job-equiv"


class FakeRedis:
    def __init__(self) -> None:
        self.live: list[dict] = []
        self._seq = 0

    def incr(self, name):  # noqa: ANN001, ANN201
        self._seq += 1
        return self._seq

    def expire(self, name, time):  # noqa: ANN001, ANN201
        return True

    def hset(self, name, key, value):  # noqa: ANN001, ANN201
        return 1

    def publish(self, channel, message):  # noqa: ANN001, ANN201
        if channel.endswith(":live"):
            self.live.append(json.loads(message))


def _answer(payload: dict) -> str:
    given = json.loads(payload["messages"][1]["content"])
    # The keyed passes send no responseSchema by default, so the pass is told apart by the
    # shape of what it was asked about.
    first = next(iter(given.values()))
    if isinstance(first, str):
        name = "title_tags_by_row"
    elif "requirement_titles" in first:
        name = "parent_summary_by_node"
    else:
        name = "synthesized_requirements_by_row"
    if name == "title_tags_by_row":
        return json.dumps(
            {k: {"title": f"T {v[:14]}", "tags": ["safety"]} for k, v in given.items()}
        )
    if name == "synthesized_requirements_by_row":
        return json.dumps(
            {
                k: {
                    "title": f"S {v['text'][:10]}",
                    "text": f"The system shall {v['text']}.",
                    "tags": [],
                }
                for k, v in given.items()
            }
        )
    if name == "parent_summary_by_node":
        return json.dumps(
            {k: {"title": f"P {v['title']}", "description": f"About {v['title']}."}
             for k, v in given.items()}
        )
    raise AssertionError(f"unexpected call {name}")


def _handler(request: httpx.Request) -> httpx.Response:
    content = _answer(json.loads(request.content))
    if request.url.path == "/llm/chat":
        return httpx.Response(200, json={"content": content})
    step = 17
    lines = [json.dumps({"delta": content[i : i + step]}) for i in range(0, len(content), step)]
    lines.append(json.dumps({"done": True, "finishReason": "stop"}))
    return httpx.Response(200, content=("\n".join(lines) + "\n").encode())


def _rows() -> list[HierarchyRow]:
    def sr(i: int) -> SourceRef:
        return SourceRef(document_path="x.docx", start_offset=i, end_offset=i + 1)

    rows = [
        HierarchyRow(label="Power", has_shall=False, source_ref=sr(0), node_type="Epic",
                     parent_index=None, id_text="1", id_disambiguator_needed=False,
                     needs_synthesis=False, id_text_is_authored=True),
        HierarchyRow(label="Input", has_shall=False, source_ref=sr(1), node_type="Feature",
                     parent_index=0, id_text="1.1", id_disambiguator_needed=False,
                     needs_synthesis=False, id_text_is_authored=True),
    ]
    for i in range(7):
        rows.append(
            HierarchyRow(
                label=f"Item {i}: input range {i} V", has_shall=i % 2 == 0, source_ref=sr(2 + i),
                node_type="Requirement", parent_index=1, id_text=f"1.1.{i + 1}",
                id_disambiguator_needed=False, needs_synthesis=i % 3 == 0, id_text_is_authored=True,
            )
        )
    return rows


def _build(monkeypatch, *, stream: bool, redis: FakeRedis):  # noqa: ANN001, ANN202
    monkeypatch.setattr(client_module.settings, "live_progress", stream)
    monkeypatch.setattr(client_module.settings, "llm_stream_drafting", stream)
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="t")
    client._transport = httpx.MockTransport(_handler)
    with job_id_scope(JOB), live_emitter_scope(JOB, redis):
        nodes, warnings = build_hierarchy_subtree(
            _rows(), "det0_", client, synthesis_client=client, user_id="u1", chunk_concurrency=2,
        )
    return [n.model_dump(mode="json") for n in nodes], [w.model_dump(mode="json") for w in warnings]


def test_the_built_tree_is_identical_with_streaming_off_and_on(monkeypatch) -> None:  # noqa: ANN001
    off_redis, on_redis = FakeRedis(), FakeRedis()
    off = _build(monkeypatch, stream=False, redis=off_redis)
    on = _build(monkeypatch, stream=True, redis=on_redis)

    assert on == off
    assert off_redis.live == []  # nothing is published with the flags off
    assert any(f["kind"] == "item" for f in on_redis.live)  # and something is, with them on
