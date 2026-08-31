# ingestion/tests/test_section_analysis_options.py
import dataclasses

import pytest

from app.section_analysis_options import DEFAULT_SECTION_ANALYSIS_OPTIONS, SectionAnalysisOptions


def test_defaults_match_the_parameter_defaults_this_dataclass_replaced() -> None:
    # These six defaults are a documented contract, not convenience: the
    # Protocol's own comments state that omitting expected_root_count
    # "preserves today's exact single-root wording" and that omitting the
    # optional hints is "byte-identical to before this capability existed".
    options = SectionAnalysisOptions()

    assert options.whole_document is False
    assert options.topic_count is None
    assert options.table_group_hints is None
    assert options.expected_root_count is None
    assert options.requirement_row_hints is None
    assert options.heading_type_hints is None


def test_field_set_is_exactly_the_six_steering_parameters() -> None:
    # Guard against scope creep: section_text, kb_context, retrieve_fn and
    # the three agentic tool closures deliberately stay standalone
    # parameters (see the plan's Design decision 1). A seventh field
    # appearing here without that decision being revisited is a bug.
    assert {f.name for f in dataclasses.fields(SectionAnalysisOptions)} == {
        "whole_document",
        "topic_count",
        "table_group_hints",
        "expected_root_count",
        "requirement_row_hints",
        "heading_type_hints",
    }


def test_construction_is_keyword_only() -> None:
    # kw_only=True is what makes six defaulted fields safe: a seventh hint
    # appended later can never silently shift a positional argument,
    # because positional construction does not exist.
    with pytest.raises(TypeError):
        SectionAnalysisOptions(True)  # type: ignore[misc]


def test_is_frozen_so_the_shared_default_singleton_cannot_be_mutated() -> None:
    options = SectionAnalysisOptions(topic_count=7)

    with pytest.raises(dataclasses.FrozenInstanceError):
        options.topic_count = 9  # type: ignore[misc]


def test_carries_every_supplied_hint_verbatim() -> None:
    options = SectionAnalysisOptions(
        whole_document=True,
        topic_count=7,
        table_group_hints=[("Media Buttons", "Feature")],
        expected_root_count=2,
        requirement_row_hints=[("P-SENSOR-001#", "Time sync source")],
        heading_type_hints=[("Target Handling", "Epic")],
    )

    assert options.whole_document is True
    assert options.topic_count == 7
    assert options.table_group_hints == [("Media Buttons", "Feature")]
    assert options.expected_root_count == 2
    assert options.requirement_row_hints == [("P-SENSOR-001#", "Time sync source")]
    assert options.heading_type_hints == [("Target Handling", "Epic")]


def test_default_singleton_is_an_all_defaults_instance() -> None:
    assert DEFAULT_SECTION_ANALYSIS_OPTIONS == SectionAnalysisOptions()


def test_replace_produces_an_independent_instance() -> None:
    # dataclasses.replace is how a caller derives a narrowed options object
    # (used by analyze_section_agentic's degraded fallback, which must keep
    # forwarding only whole_document/topic_count -- see the plan's
    # invariant (b)).
    base = SectionAnalysisOptions(whole_document=True, topic_count=7, expected_root_count=2)
    narrowed = dataclasses.replace(base, expected_root_count=None)

    assert narrowed.expected_root_count is None
    assert base.expected_root_count == 2
    assert narrowed.whole_document is True
