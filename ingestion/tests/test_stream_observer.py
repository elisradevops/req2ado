import json

import pytest

from app.leveling.stream_observer import ObservedItem, StreamObserver

ID_KEYED = {
    "r001": {"title": "Provide 28 V DC", "tags": ["power"]},
    "r002": {"title": 'Quote "inside" and } brace', "tags": []},
    "r003": {"title": "Unicode שלום 日本語 → arrow", "tags": ["a", "b"]},
    "r004": {
        "title": "Escapes \\ backslash \n newline",
        "tags": ["x"],
        "text": "A [bracket] and {curly}.",
    },
}
NODES = {
    "nodes": [
        {"temp_id": "n1", "type": "Epic", "title": "Power", "parent_temp_id": None},
        {"temp_id": "n2", "type": "Requirement", "title": "Ripple [50 mV]", "parent_temp_id": "n1"},
        {"temp_id": "n3", "type": "Requirement", "title": "Faults", "parent_temp_id": "n1"},
    ]
}


def _collect(text: str, chunk: int | None = None) -> list[ObservedItem]:
    items: list[ObservedItem] = []
    observer = StreamObserver(items.append)
    if chunk is None:
        observer.feed(text)
    else:
        for start in range(0, len(text), chunk):
            observer.feed(text[start : start + chunk])
    return items


def test_id_keyed_object_emits_each_value_in_order() -> None:
    items = _collect(json.dumps(ID_KEYED, ensure_ascii=False))
    assert [i.key for i in items] == list(ID_KEYED)
    assert [i.value for i in items] == list(ID_KEYED.values())
    assert [i.index for i in items] == [0, 1, 2, 3]


def test_nodes_array_emits_each_element_with_an_indexed_key() -> None:
    items = _collect(json.dumps(NODES))
    assert [i.key for i in items] == ["nodes[0]", "nodes[1]", "nodes[2]"]
    assert [i.value for i in items] == NODES["nodes"]


@pytest.mark.parametrize("payload", [ID_KEYED, NODES], ids=["id-keyed", "nodes"])
@pytest.mark.parametrize("pretty", [False, True])
def test_every_split_point_gives_the_same_items(payload, pretty) -> None:  # noqa: ANN001
    text = json.dumps(payload, ensure_ascii=False, indent=2 if pretty else None)
    expected = [(i.key, i.value) for i in _collect(text)]
    assert expected, "the reference parse should find items"
    # One split anywhere in the text, including inside a string or an escape.
    for cut in range(1, len(text)):
        observer_items: list[ObservedItem] = []
        observer = StreamObserver(observer_items.append)
        observer.feed(text[:cut])
        observer.feed(text[cut:])
        assert [(i.key, i.value) for i in observer_items] == expected, f"cut at {cut}"


@pytest.mark.parametrize("chunk", [1, 2, 3, 7, 64])
def test_fixed_size_chunks_give_the_same_items(chunk: int) -> None:
    text = json.dumps(ID_KEYED, ensure_ascii=False)
    assert [(i.key, i.value) for i in _collect(text, chunk)] == [
        (k, v) for k, v in ID_KEYED.items()
    ]


def test_items_arrive_as_soon_as_they_close_not_at_the_end() -> None:
    text = json.dumps(ID_KEYED)
    first_two_end = text.index('"r003"')
    items: list[ObservedItem] = []
    observer = StreamObserver(items.append)
    observer.feed(text[:first_two_end])
    assert [i.key for i in items] == ["r001", "r002"]
    assert observer.pending_key is None or observer.pending_key == ""


def test_pending_key_names_the_row_being_written() -> None:
    items: list[ObservedItem] = []
    observer = StreamObserver(items.append)
    observer.feed('{"r001": {"title": "Done"}, "r002": {"title": "Writi')
    assert [i.key for i in items] == ["r001"]
    assert observer.pending_key == "r002"


def test_text_before_the_object_is_ignored() -> None:
    text = "Here is the JSON:\n```json\n" + json.dumps(ID_KEYED) + "\n```"
    assert [i.key for i in _collect(text)] == list(ID_KEYED)


def test_trailing_garbage_after_the_object_does_not_add_items() -> None:
    text = json.dumps(ID_KEYED) + "}  stray"
    assert len(_collect(text)) == 4


def test_a_truncated_response_yields_only_the_completed_items() -> None:
    text = json.dumps(ID_KEYED)
    cut = text.index('"r004"') + 12
    items = _collect(text[:cut])
    assert [i.key for i in items] == ["r001", "r002", "r003"]


def test_the_known_decoder_quirk_of_a_missing_final_brace_still_emits_every_item() -> None:
    # `_parse_json_object` repairs a response that stops one '}' short; the
    # observer must still have shown every completed item.
    text = json.dumps(ID_KEYED)[:-1]
    assert [i.key for i in _collect(text)] == list(ID_KEYED)


def test_the_decoder_quirk_of_a_node_missing_its_closing_brace_does_not_break_observation() -> None:
    # `_parse_json_object` repairs `... "tags": []\n  ]\n}` (the last node lost its
    # '}'). The observer must keep what was already shown and never raise.
    text = '{"nodes": [{"temp_id": "n1", "title": "A"}, {"temp_id": "n2", "title": "B"]}'
    items = _collect(text)
    assert items[0].key == "nodes[0]" and items[0].value == {"temp_id": "n1", "title": "A"}
    assert len(items) == 2 and items[1].value is None


def test_unparseable_child_is_reported_with_no_value() -> None:
    items = _collect('{"r001": {"title": "a" "tags": []}}')
    assert len(items) == 1
    assert items[0].key == "r001"
    assert items[0].value is None
    assert items[0].raw.startswith("{")


def test_scalar_and_empty_inputs_emit_nothing() -> None:
    assert _collect("") == []
    assert _collect("just words") == []
    assert _collect('{"a": 1, "b": "x"}') == []
    assert _collect("[1, 2, 3]") == []
    assert _collect("{}") == []


def test_a_throwing_callback_stops_the_observer_without_raising() -> None:
    calls: list[str] = []

    def boom(item: ObservedItem) -> None:
        calls.append(item.key)
        raise RuntimeError("consumer exploded")

    observer = StreamObserver(boom)
    observer.feed(json.dumps(ID_KEYED))  # must not raise
    assert observer.broken is True
    assert calls == ["r001"]
    observer.feed("more text")  # ignored, still no raise
    assert calls == ["r001"]


def test_nested_objects_inside_an_item_are_part_of_that_item() -> None:
    payload = {"r1": {"title": "t", "extra": {"deep": [{"x": 1}, {"y": 2}]}}, "r2": {"title": "u"}}
    items = _collect(json.dumps(payload))
    assert [i.key for i in items] == ["r1", "r2"]
    assert items[0].value == payload["r1"]


def test_many_items_are_counted() -> None:
    payload = {f"r{i:04d}": {"title": f"t{i}", "tags": []} for i in range(500)}
    observer_items: list[ObservedItem] = []
    observer = StreamObserver(observer_items.append)
    observer.feed(json.dumps(payload))
    assert len(observer_items) == observer.items_seen == 500
