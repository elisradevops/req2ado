"""The keyed-result module (app.survey.keyed_calls): one contract for "ask about N ids, get
N validated entries back" -- schema, prompt sentence, tolerant parsing, bounded recovery."""
import json
import logging

import httpx
import pytest

import app.survey.keyed_calls as keyed_calls_module
import app.survey.orchestrator_llm_client as client_module
from app.leveling.id_tree_builder import _apply_title_tag_pass, build_hierarchy_subtree
from app.leveling.live_stream import DraftingDisplay
from app.prompts import load_prompt
from app.survey.keyed_calls import (
    KeyedEntries,
    KeyedSpec,
    describe_output,
    items_schema,
    mode_for,
    normalize_keyed_result,
    reset_degraded,
    retry_omitted,
    run_keyed,
    schema_for,
)
from app.survey.keyed_specs import TITLE_TAGS_SPEC
from app.survey.orchestrator_llm_client import OrchestratorLlmClient
from app.workitem.model import RequirementTag, WarningKind

SPEC = TITLE_TAGS_SPEC


@pytest.fixture(autouse=True)
def _default_modes(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_mode", "none")
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "")
    reset_degraded()
    yield
    reset_degraded()


# -- spec ---------------------------------------------------------------------------------


def test_a_spec_must_describe_every_field_in_the_prompt_and_may_not_use_the_reserved_id() -> None:
    with pytest.raises(ValueError, match="same fields"):
        KeyedSpec(name="x", schema_name="x", fields={"a": {"type": "string"}}, field_prompts={"b": "'b'"})
    with pytest.raises(ValueError, match="reserved"):
        KeyedSpec(name="x", schema_name="x", fields={"id": {"type": "string"}}, field_prompts={"id": "'id'"})


# -- modes --------------------------------------------------------------------------------


def test_mode_defaults_to_the_global_setting_and_a_named_pass_is_forced_to_array(monkeypatch) -> None:
    assert mode_for(SPEC) == "none"
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "synthesis, title_tag ,x")
    assert mode_for(SPEC) == "array"
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "synthesis")
    assert mode_for(SPEC) == "none"
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_mode", "array")
    assert mode_for(SPEC) == "array"


# -- schema -------------------------------------------------------------------------------


def _walk(node):
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def test_the_array_schema_follows_the_vendor_rules_for_strict_structured_output() -> None:
    schema = items_schema(SPEC)["schema"]
    objects = [n for n in _walk(schema) if isinstance(n, dict) and n.get("type") == "object"]
    assert objects, "expected object schemas"
    for obj in objects:
        # Closed objects (Anthropic + OpenAI/Azure strict), every property required.
        assert obj["additionalProperties"] is False
        assert set(obj["required"]) == set(obj["properties"])
    forbidden = {"minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "patternProperties"}
    assert not any(isinstance(n, dict) and forbidden & n.keys() for n in _walk(schema))
    entry = schema["properties"]["items"]["items"]
    assert list(entry["properties"]) == ["id", "title", "tags"]


def test_the_array_schema_does_not_grow_with_the_number_of_ids() -> None:
    # The whole point: a constant, cacheable schema (per-key schemas hit the provider limits at ~50 keys).
    assert json.dumps(items_schema(SPEC)) == json.dumps(items_schema(SPEC))
    assert len(json.dumps(items_schema(SPEC))) < 1500


def test_schema_for_each_mode(monkeypatch) -> None:
    assert schema_for(SPEC, "none") is None
    assert schema_for(SPEC, "array") == items_schema(SPEC)
    legacy = schema_for(SPEC, "legacy_map")
    assert legacy is not None and "additionalProperties" in legacy["schema"]


# -- prompt -------------------------------------------------------------------------------


def test_the_output_sentence_and_the_schema_are_generated_from_the_same_fields() -> None:
    sentence = describe_output(SPEC, "array")
    for name in SPEC.fields:
        assert SPEC.field_prompts[name] in sentence
    assert set(items_schema(SPEC)["schema"]["properties"]["items"]["items"]["properties"]) == {"id", *SPEC.fields}
    assert '"items"' in sentence and '"id"' in sentence


def test_the_default_mode_renders_exactly_the_prompt_prod_already_ran() -> None:
    # v2 only turns the output-format sentence into a marker; in none / legacy_map mode the
    # rendered prompt must be byte-identical to v1, so the default behaviour does not change.
    markers = {"tag_vocabulary": ", ".join(t.value for t in RequirementTag), "row_count": "3"}
    v1 = load_prompt("title_and_tags_for_rows", version=1, **markers)
    for mode in ("none", "legacy_map"):
        v2 = load_prompt("title_and_tags_for_rows", version=2, output_format=describe_output(SPEC, mode), **markers)
        assert v2 == v1


# -- tolerant parsing ---------------------------------------------------------------------

IDS = ["r1", "r2"]
ENTRY = {"title": "T", "tags": []}


def test_normalize_reads_the_array_format() -> None:
    result = normalize_keyed_result({"items": [{"id": "r1", **ENTRY}, {"id": " r2 ", **ENTRY}]}, IDS)
    assert result == {"r1": ENTRY, "r2": ENTRY}


def test_normalize_reads_a_bare_array_the_legacy_map_and_a_wrapped_map() -> None:
    assert normalize_keyed_result([{"id": "r1", **ENTRY}], IDS) == {"r1": ENTRY}
    assert normalize_keyed_result({"r1": ENTRY, " r2": ENTRY}, IDS) == {"r1": ENTRY, "r2": ENTRY}
    assert normalize_keyed_result({"results": {"r1": ENTRY}}, IDS) == {"r1": ENTRY}
    assert normalize_keyed_result({"output": {"items": [{"id": "r1", **ENTRY}]}}, IDS) == {"r1": ENTRY}


def test_normalize_never_mistakes_a_genuine_one_entry_answer_for_a_wrapper() -> None:
    assert normalize_keyed_result({"r1": ENTRY}, IDS) == {"r1": ENTRY}


@pytest.mark.parametrize("garbage", [None, "text", 3, {}, [], [{"nope": 1}], {"items": "x"}, {"items": [{"id": "zzz"}]}])
def test_normalize_yields_nothing_usable_for_garbage(garbage) -> None:
    assert not (set(normalize_keyed_result(garbage, IDS)) & set(IDS))


# -- recovery -----------------------------------------------------------------------------


def _send_factory(answers):
    """send(payload) -> next canned answer; records the id lists it was asked about."""
    calls: list[list[str]] = []
    modes: list[str | None] = []
    queue = list(answers)

    def send(payload: dict, mode: str | None = None) -> object:
        calls.append(list(payload))
        modes.append(mode)
        answer = queue.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer(payload) if callable(answer) else answer

    send.modes = modes  # type: ignore[attr-defined]
    return send, calls


def _all(payload):
    return {"items": [{"id": k, **ENTRY} for k in payload]}


PAYLOAD = {f"r{i}": f"text {i}" for i in range(6)}


def test_a_complete_answer_costs_one_call_and_logs_at_info(caplog) -> None:
    send, calls = _send_factory([_all])
    with caplog.at_level(logging.INFO, logger="app.survey.keyed_calls"):
        entries = run_keyed(send, PAYLOAD, SPEC)
    assert len(calls) == 1
    assert isinstance(entries, dict) and isinstance(entries, KeyedEntries)
    assert entries.reason is None and entries.missing == [] and entries.requested == list(PAYLOAD)
    assert [r.levelno for r in caplog.records] == [logging.INFO]


def test_omitted_ids_are_retried_once_in_halves() -> None:
    first = lambda payload: {"items": [{"id": k, **ENTRY} for k in list(payload)[:2]]}  # noqa: E731
    send, calls = _send_factory([first, _all, _all])
    entries = run_keyed(send, PAYLOAD, SPEC)
    assert calls[0] == list(PAYLOAD)
    assert calls[1] + calls[2] == list(PAYLOAD)[2:]  # only the 4 omitted ids, split in two
    assert entries.reason is None and set(entries) == set(PAYLOAD)


def test_a_systematic_failure_stops_after_one_extra_call_and_is_not_called_an_omission() -> None:
    send, calls = _send_factory([{}, {}])
    entries = run_keyed(send, PAYLOAD, SPEC)
    assert len(calls) == 2  # the full call, then the first half only
    assert entries.reason == "no_matching_keys" and len(entries) == 0 and entries.missing == list(PAYLOAD)


def test_a_retry_that_raises_leaves_the_ids_omitted_without_failing_the_call() -> None:
    first = lambda payload: {"items": [{"id": "r0", **ENTRY}]}  # noqa: E731
    send, _ = _send_factory([first, RuntimeError("upstream down")])
    entries = run_keyed(send, PAYLOAD, SPEC)
    assert entries.reason == "partial" and set(entries) == {"r0"}


def test_nothing_is_sent_for_an_empty_payload() -> None:
    send, calls = _send_factory([])
    assert run_keyed(send, {}, SPEC) == {}
    assert calls == []


def test_the_zero_match_log_names_ids_only_and_cuts_keys_short(caplog) -> None:
    long_key = "A very long sentence the model used as a key because it answered in prose " * 3
    send, _ = _send_factory([{long_key: 1}, {}])
    with caplog.at_level(logging.WARNING, logger="app.survey.keyed_calls"):
        run_keyed(send, PAYLOAD, SPEC)
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "none of the 6 requested ids came back" in text
    assert long_key not in text and long_key[:40] in text


def test_retry_omitted_reports_how_many_extra_calls_it_made() -> None:
    send, calls = _send_factory([_all, _all])
    merged, extra = retry_omitted({}, list(PAYLOAD), PAYLOAD, send, "x")
    assert extra == 2 and set(merged) == set(PAYLOAD)


# -- the client uses it -------------------------------------------------------------------


def _client(handler):
    client = OrchestratorLlmClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)
    return client


ROWS = {"det0_h1": "Size: 3U 1 inch", "det0_h2": "Over-current protection"}


def test_title_and_tags_in_array_mode_sends_the_fixed_schema_and_a_matching_prompt(monkeypatch) -> None:
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "title_tag")
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        content = {"items": [{"id": k, "title": f"T {k}", "tags": ["safety"]} for k in json.loads(body["messages"][1]["content"])]}
        return httpx.Response(200, json={"content": json.dumps(content)})

    result = _client(handler).title_and_tags_for_rows(ROWS)

    assert result == {k: {"title": f"T {k}", "tags": ["safety"]} for k in ROWS}  # array -> id map at the boundary
    assert len(bodies) == 1
    assert bodies[0]["responseSchema"] == items_schema(SPEC)
    prompt = bodies[0]["messages"][0]["content"]
    assert describe_output(SPEC, "array") in prompt and "exactly 2 row(s)" in prompt


def test_title_and_tags_in_none_mode_still_reads_a_legacy_map_answer() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "responseSchema" not in json.loads(request.content)
        return httpx.Response(200, json={"content": json.dumps({k: {"title": "T", "tags": []} for k in ROWS})})

    assert set(_client(handler).title_and_tags_for_rows(ROWS)) == set(ROWS)


def test_title_and_tags_retries_only_the_omitted_ids() -> None:
    seen: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked = list(json.loads(json.loads(request.content)["messages"][1]["content"]))
        seen.append(asked)
        answered = asked[:1] if len(seen) == 1 else asked
        return httpx.Response(200, json={"content": json.dumps({k: {"title": "T", "tags": []} for k in answered})})

    result = _client(handler).title_and_tags_for_rows(ROWS)
    assert set(result) == set(ROWS)
    assert seen == [list(ROWS), [list(ROWS)[1]]]


# -- the pass consumes it -----------------------------------------------------------------


def _nodes(count=4):
    from tests.test_id_tree_builder import _many_requirement_rows

    nodes, _ = build_hierarchy_subtree(_many_requirement_rows(count), "det0_")
    return nodes, [n.local_id for n in nodes]


def test_the_title_tag_pass_does_not_retry_again_when_the_client_already_did() -> None:
    nodes, ids = _nodes()
    calls = {"n": 0}

    class MigratedClient:
        def title_and_tags_for_rows(self, texts_by_row_id, user_id=None):
            calls["n"] += 1
            return KeyedEntries({ids[0]: {"title": "Only", "tags": []}}, list(texts_by_row_id))

    warnings: list = []
    _apply_title_tag_pass(nodes, ids, MigratedClient(), warnings)

    assert calls["n"] == 1  # the pass trusts the KeyedEntries (its own retry would have called again)
    assert next(n for n in nodes if n.local_id == ids[0]).title == "Only"
    assert [w.kind for w in warnings] == [WarningKind.ENHANCEMENT_RESPONSE_INCOMPLETE]


def test_the_title_tag_pass_reports_a_keyed_zero_match_as_a_failure() -> None:
    nodes, ids = _nodes()

    class EmptyClient:
        def title_and_tags_for_rows(self, texts_by_row_id, user_id=None):
            return KeyedEntries({}, list(texts_by_row_id))

    warnings: list = []
    _apply_title_tag_pass(nodes, ids, EmptyClient(), warnings)

    assert [w.kind for w in warnings] == [WarningKind.ENHANCEMENT_CALL_FAILED]
    assert warnings[0].detail == {"pass": "title_tag", "reason": "no_matching_keys"}


# -- the live screen ----------------------------------------------------------------------


class _RecordingEmitter:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def acquire_lane(self) -> int:
        return 0

    def working_on(self, **kwargs) -> None:
        pass

    def item(self, **kwargs) -> None:
        self.items.append(kwargs)

    def reset(self, **kwargs) -> None:
        pass

    def flush(self) -> None:
        pass


def test_the_live_display_names_each_array_item_by_its_id() -> None:
    emitter = _RecordingEmitter()
    display = DraftingDisplay(emitter, {"r1": "a", "r2": "b"})
    stream = json.dumps({"items": [{"id": "r1", "title": "First", "tags": []}, {"id": "r2", "title": "Second", "tags": []}]})
    for start in range(0, len(stream), 7):  # arbitrary chunking, including splits inside strings
        display.feed(stream[start : start + 7])

    assert [(i["ref"], i["title"]) for i in emitter.items] == [("r1", "First"), ("r2", "Second")]


def test_the_live_display_still_names_legacy_map_items_by_their_key() -> None:
    emitter = _RecordingEmitter()
    display = DraftingDisplay(emitter, {"r1": "a"})
    display.feed(json.dumps({"r1": {"title": "First", "tags": []}}))
    assert [(i["ref"], i["title"]) for i in emitter.items] == [("r1", "First")]


# -- the array schema on a route nobody documents: fall back, then remember ---------------


@pytest.fixture
def array_mode(monkeypatch):
    monkeypatch.setattr(keyed_calls_module.settings, "keyed_schema_passes", "title_tag")


def test_an_empty_array_answer_falls_back_to_prompt_only_once_and_the_pair_stays_degraded(array_mode, caplog) -> None:
    send, calls = _send_factory([{"items": []}, _all, _all])
    with caplog.at_level(logging.WARNING, logger="app.survey.keyed_calls"):
        first = run_keyed(send, PAYLOAD, SPEC, model="claude-opus-4-8")

    assert send.modes == ["array", "none"]  # the schema'd call, then the same call prompt-only -- no half retry first
    assert first.reason is None and first.degraded is True and first.mode == "none"
    assert any("from now on" in r.getMessage() for r in caplog.records)
    assert mode_for(SPEC, "claude-opus-4-8") == "none"

    # Later chunks for the same pass and model go straight to prompt-only...
    second = run_keyed(send, PAYLOAD, SPEC, model="claude-opus-4-8")
    assert send.modes[2:] == ["none"] and second.degraded is False and second.mode == "none"
    # ...but another model still gets the schema.
    assert mode_for(SPEC, "gpt-4o") == "array"


def test_a_partial_array_answer_is_not_a_reason_to_abandon_the_schema(array_mode) -> None:
    first = lambda payload: {"items": [{"id": "r0", **ENTRY}]}  # noqa: E731
    send, _ = _send_factory([first, _all, _all])
    entries = run_keyed(send, PAYLOAD, SPEC, model="m")

    assert send.modes == ["array", "array", "array"]  # the retry of the omitted ids stays on the schema
    assert entries.reason is None and entries.degraded is False
    assert mode_for(SPEC, "m") == "array"


def test_if_prompt_only_gets_nothing_either_the_schema_is_not_blamed(array_mode) -> None:
    send, _ = _send_factory([{"items": []}, {}])
    entries = run_keyed(send, PAYLOAD, SPEC, model="m")

    assert send.modes == ["array", "none"]  # no half retry after a fallback that also found nothing
    assert entries.reason == "no_matching_keys" and entries.degraded is False
    assert mode_for(SPEC, "m") == "array"


def test_prompt_only_mode_never_falls_back() -> None:
    send, _ = _send_factory([{}, {}])
    run_keyed(send, PAYLOAD, SPEC, model="m")
    assert send.modes == ["none", "none"]  # one full call, then the single half retry


def test_client_degrades_after_the_schema_returns_nothing_and_stops_sending_it(array_mode) -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        asked = list(json.loads(body["messages"][1]["content"]))
        if "responseSchema" in body:  # the schema'd call is answered with an empty array
            return httpx.Response(200, json={"content": json.dumps({"items": []})})
        return httpx.Response(200, json={"content": json.dumps({k: {"title": "T", "tags": []} for k in asked})})

    client = _client(handler)
    assert set(client.title_and_tags_for_rows(ROWS)) == set(ROWS)
    assert set(client.title_and_tags_for_rows(ROWS)) == set(ROWS)

    assert ["responseSchema" in b for b in bodies] == [True, False, False]  # schema once, then prompt-only
    assert "exactly one" not in bodies[2]["messages"][0]["content"]  # and the prompt asks for the map shape again


def test_a_truncated_array_answer_keeps_its_complete_items_and_only_the_rest_is_retried(array_mode) -> None:
    # Documented caveat: hitting max_tokens can cut the answer off mid-array ("may be incomplete and not
    # match your schema"). The complete elements before the cut must survive, and only what is missing
    # is asked again.
    asked_lists: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        asked = list(json.loads(body["messages"][1]["content"]))
        asked_lists.append(asked)
        if len(asked_lists) == 1:
            truncated = '{"items": [{"id": "det0_h1", "title": "Complete", "tags": []}, {"id": "det0_h2", "ti'
            return httpx.Response(200, json={"content": truncated, "finishReason": "length"})
        full = {"items": [{"id": k, "title": f"Retried {k}", "tags": []} for k in asked]}
        return httpx.Response(200, json={"content": json.dumps(full), "finishReason": "stop"})

    result = _client(handler).title_and_tags_for_rows(ROWS)

    assert result["det0_h1"]["title"] == "Complete"  # kept from the truncated answer
    assert result["det0_h2"]["title"] == "Retried det0_h2"  # only this one was asked again
    assert asked_lists == [list(ROWS), ["det0_h2"]]


def test_an_entry_with_none_of_the_contracts_fields_is_not_counted_as_returned() -> None:
    result = normalize_keyed_result({"items": [{"id": "r1", **ENTRY}, {"id": "r2"}]}, IDS, ["title", "tags"])
    assert set(result) == {"r1"}
    legacy = normalize_keyed_result({"r1": ENTRY, "r2": {}}, IDS, ["title", "tags"])
    assert set(legacy) == {"r1"}
    # without a field list (unmigrated passes) nothing is filtered, as before
    assert set(normalize_keyed_result({"r1": ENTRY, "r2": {}}, IDS)) == {"r1", "r2"}


def test_a_length_truncated_answer_distrusts_its_last_entry_but_other_shapes_are_untouched() -> None:
    from app.survey.keyed_calls import drop_possibly_cut_last_entry

    assert drop_possibly_cut_last_entry({"items": [{"id": "a"}, {"id": "b"}]}) == {"items": [{"id": "a"}]}
    assert drop_possibly_cut_last_entry({"a": {"t": 1}, "b": {"t": 2}}) == {"a": {"t": 1}}
    verdict = {"verdict": "redundant", "conflicting_values": ["x"]}
    assert drop_possibly_cut_last_entry(verdict) == verdict  # a fixed-shape object is not an entry list
    assert drop_possibly_cut_last_entry({"links": [1, 2]}) == {"links": [1, 2]}
    assert drop_possibly_cut_last_entry({"items": []}) == {"items": []}


def test_a_title_cut_off_by_the_token_limit_is_not_kept_as_if_it_were_final(array_mode) -> None:
    asked_lists: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked = list(json.loads(json.loads(request.content)["messages"][1]["content"]))
        asked_lists.append(asked)
        if len(asked_lists) == 1:
            # the second element parses (the reader repairs it) but its title stops half way
            cut = '{"items": [{"id": "det0_h1", "title": "Complete", "tags": []}, {"id": "det0_h2", "title": "Half a ti'
            return httpx.Response(200, json={"content": cut, "finishReason": "length"})
        full = {"items": [{"id": k, "title": f"Retried {k}", "tags": []} for k in asked]}
        return httpx.Response(200, json={"content": json.dumps(full), "finishReason": "stop"})

    result = _client(handler).title_and_tags_for_rows(ROWS)

    assert result["det0_h2"]["title"] == "Retried det0_h2"  # not "Half a ti"
    assert asked_lists == [list(ROWS), ["det0_h2"]]
