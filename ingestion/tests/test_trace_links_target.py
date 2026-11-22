"""How a trace-link answer's target is read: v5 names a node or a cited identifier in separate fields; before v5 one field carried both."""

from app.leveling.trace_links import _link_target
from app.survey._response_schemas import trace_links_schema

NODES = {"n1": object(), "n2": object()}


def test_v5_answers_name_a_node_or_an_identifier() -> None:
    assert _link_target({"target_node_id": "n2", "target_external_id": ""}, NODES) == ("n2", False)
    assert _link_target({"target_node_id": "", "target_external_id": "REQ-SYS-012"}, NODES) == (
        "REQ-SYS-012",
        True,
    )


def test_a_node_id_that_is_not_in_the_tree_is_not_taken_for_an_identifier() -> None:
    # Before v5 an invented node id became a cross-job link to a "customer id" of that name.
    assert _link_target({"target_node_id": "n9", "target_external_id": ""}, NODES) == (None, False)
    assert _link_target({"target_ref": "n9"}, NODES) == ("n9", True)


def test_both_or_neither_target_is_no_target() -> None:
    assert _link_target({"target_node_id": "n2", "target_external_id": "REQ-1"}, NODES) == (
        None,
        False,
    )
    assert _link_target({"target_node_id": "", "target_external_id": ""}, NODES) == (None, False)
    assert _link_target({}, NODES) == (None, False)


def test_the_schema_follows_the_answer_shape() -> None:
    def fields(schema: dict) -> list[str]:
        return schema["schema"]["properties"]["links"]["items"]["required"]

    assert fields(trace_links_schema()) == [
        "source_node_id",
        "reference_name",
        "target_node_id",
        "target_external_id",
        "evidence_quote",
    ]
    assert "target_ref" in fields(trace_links_schema(split_target=False))


def test_both_answer_shapes_are_portable() -> None:
    from app.survey.portable_schema import portable_schema_violations

    for split in (True, False):
        assert portable_schema_violations(trace_links_schema(split)["schema"]) == []
