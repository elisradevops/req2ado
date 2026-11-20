"""What a document's headings state or show about their own types: a labelled-heading convention, and the depth the file writes requirements at."""

from __future__ import annotations

from app.leveling.hierarchy_rules import learn_leaf_floor, type_headings_by_shape
from app.study.heading_rules import apply_stated_type_labels

from .test_hierarchy_rules import E, F, R, _tree


def _rehash(text: str) -> str:
    return f"hash:{text}"


# --- labelled headings ------------------------------------------------------------------------------------------------------------------


def test_a_file_that_labels_its_headings_states_their_types_and_the_label_leaves_the_title() -> (
    None
):
    nodes = _tree(
        [
            ("a", None, "Epic: Top"),
            ("b", "a", "Feature: Power"),
            ("c", "b", "Requirement: Start-up time"),
            ("d", "b", "Requirement: Shutdown"),
        ]
    )
    nodes[2].description = "Requirement: Start-up time"
    locked = apply_stated_type_labels(nodes, _rehash)
    assert locked == {"a": E, "b": F, "c": R, "d": R}
    assert [n.title for n in nodes] == ["Top", "Power", "Start-up time", "Shutdown"]
    assert (
        nodes[2].description == "Start-up time" and nodes[2].fidelity_hash == "hash:Start-up time"
    )


def test_a_heading_number_stays_when_the_label_goes() -> None:
    nodes = _tree(
        [
            ("a", None, "1 Epic: Top"),
            ("b", "a", "1.1 Feature: Power"),
            ("c", "b", "1.1.1 Requirement: Start"),
        ]
    )
    apply_stated_type_labels(nodes, _rehash)
    assert [n.title for n in nodes] == ["1 Top", "1.1 Power", "1.1.1 Start"]


def test_a_stray_label_in_an_unlabelled_file_is_not_a_convention() -> None:
    nodes = _tree(
        [
            ("a", None, "Overview"),
            ("b", "a", "Feature: overview"),
            ("c", "a", "Scope"),
            ("d", "a", "Limits"),
        ]
    )
    assert apply_stated_type_labels(nodes, _rehash) == {}
    assert nodes[1].title == "Feature: overview"


def test_a_stated_type_is_final_even_for_a_heading_with_no_children() -> None:
    nodes = _tree(
        [
            ("a", None, "Epic: Top"),
            ("b", "a", "Feature: Empty"),
            ("c", "a", "Feature: Full"),
            ("d", "c", "Requirement: Item"),
        ]
    )
    locked = apply_stated_type_labels(nodes, _rehash)
    type_headings_by_shape(nodes, locked=locked)
    assert {n.title: n.type for n in nodes} == {"Top": E, "Empty": F, "Full": F, "Item": R}


# --- the depth a file writes its requirements at -----------------------------------------------------------------------------------------


def _file(leaves_at_depth_2: int, leaves_at_depth_1: int):
    """An Epic with `leaves_at_depth_1` empty headings and one section holding `leaves_at_depth_2` requirement headings."""
    spec = [("e", None, "Top"), ("s", "e", "Section")]
    spec += [(f"r{i}", "s", f"Requirement {i}") for i in range(leaves_at_depth_2)]
    spec += [(f"x{i}", "e", f"Empty {i}") for i in range(leaves_at_depth_1)]
    return _tree(spec)


def test_the_floor_is_the_depth_nearly_all_leaves_share() -> None:
    assert learn_leaf_floor(_file(30, 2)) == 2


def test_mixed_depths_or_too_few_leaves_give_no_rule() -> None:
    assert learn_leaf_floor(_file(10, 10)) is None
    assert learn_leaf_floor(_file(5, 1)) is None


def test_a_leaf_above_the_floor_is_a_section_and_its_parent_stays_an_epic() -> None:
    nodes = _file(30, 2)
    type_headings_by_shape(nodes, leaf_floor=learn_leaf_floor(nodes))
    by_title = {n.title: n.type for n in nodes}
    assert by_title["Top"] == E and by_title["Section"] == F
    assert by_title["Empty 0"] == F and by_title["Empty 1"] == F
    assert by_title["Requirement 7"] == R


def test_without_a_floor_the_same_leaf_is_a_requirement_as_before() -> None:
    nodes = _file(30, 2)
    type_headings_by_shape(nodes)
    assert {n.title: n.type for n in nodes}["Empty 0"] == R
