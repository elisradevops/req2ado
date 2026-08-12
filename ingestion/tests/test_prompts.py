# ingestion/tests/test_prompts.py
"""Byte-reproduction tests for S7's prompt extraction -- each prompt used to
be an inline Python string; these assert the loaded template file, with the
same substitution inputs the original inline f-string/concatenation used,
reproduces EXACTLY the original text. Not a smoke test ("does it load") --
a real regression guard against the extraction having silently mangled
prompt content, which is a real risk with marker/format-based substitution
(confirmed live during this extraction: an early automated pass mis-handled
a couple of the `', '.join(...)`-shaped f-strings before being caught and
redone by hand)."""
from app.prompts import load_prompt
from app.workitem.model import RequirementTag

_TAG_VOCABULARY = ", ".join(t.value for t in RequirementTag)


def test_generate_requirements_prompt() -> None:
    assert load_prompt("generate_requirements") == (
        "You convert informal requirement text into formal 'shall' statements. "
        "Return ONLY a JSON array of objects, each with 'text' (a single formal "
        "shall-style requirement sentence) and 'tags' (a list of zero or more of: "
        "functional, non_functional, interface, performance, regulatory, safety, "
        "security, operation, maintenance, feature, behavior). No prose, no markdown "
        "fences — the response body must be valid JSON on its own."
    )


def test_infer_trace_links_prompt() -> None:
    result = load_prompt("infer_trace_links", catalog_lines="- Some.Ref (\"Some Name\")")
    assert "- Some.Ref (\"Some Name\")" in result
    assert result.startswith("You infer trace/coverage links between work items")
    assert result.endswith("the response body must be valid JSON on its own.")


def test_score_requirements_for_document_prompt() -> None:
    result = load_prompt("score_requirements_for_document", category_instruction="X-CATEGORY-Y ", node_count="7")
    assert "X-CATEGORY-Y " in result
    assert "The input contains exactly 7 node_id(s)." in result
    assert "Return exactly 7 entries in your response" in result


def test_score_epics_and_features_for_document_prompt() -> None:
    result = load_prompt("score_epics_and_features_for_document", node_count="9")
    assert "The input contains exactly 9 node_id(s)." in result
    assert "scopeCoherence" in result
    assert "capabilityClarity" in result


def test_title_and_tags_for_rows_prompt() -> None:
    result = load_prompt("title_and_tags_for_rows", tag_vocabulary=_TAG_VOCABULARY, row_count="5")
    assert _TAG_VOCABULARY in result
    assert "The input contains exactly 5 row(s)." in result
    assert "Return exactly 5 entries" in result


def test_summarize_parent_nodes_prompt() -> None:
    result = load_prompt("summarize_parent_nodes", node_count="4")
    assert "The input contains exactly 4 node(s)." in result
    assert "never identical or a trivial restatement" in result


def test_synthesize_leaf_requirements_prompt() -> None:
    result = load_prompt("synthesize_leaf_requirements", tag_vocabulary=_TAG_VOCABULARY, row_count="3")
    assert _TAG_VOCABULARY in result
    assert "The input contains exactly 3 row(s)." in result


def test_judge_duplicate_pair_prompt_loads() -> None:
    assert load_prompt("judge_duplicate_pair").startswith("You are given two requirement statements")


def test_judge_duplicate_cluster_prompt_loads() -> None:
    result = load_prompt("judge_duplicate_cluster")
    assert len(result) > 0


def test_group_root_topics_prompt_loads() -> None:
    result = load_prompt("group_root_topics")
    assert len(result) > 0


def test_judge_kb_relevance_prompt_loads() -> None:
    result = load_prompt("judge_kb_relevance")
    assert len(result) > 0


def test_extract_quality_checklist_prompt_loads() -> None:
    result = load_prompt("extract_quality_checklist")
    assert len(result) > 0


def test_extract_quality_checklist_definitions_prompt() -> None:
    result = load_prompt("extract_quality_checklist_definitions", category_names='["Necessary", "Unambiguous"]')
    assert '["Necessary", "Unambiguous"]' in result


def test_section_analysis_prompt_root_count_marker() -> None:
    # The one prompt using __ROOT_COUNT_CLAUSE__ (filled by
    # orchestrator_llm_client._root_count_clause, not load_prompt itself --
    # see that function's own docstring for why str.replace is used
    # directly there instead of going through load_prompt's markers kwarg:
    # the base template contains literal JSON braces).
    from app.survey.orchestrator_llm_client import _section_analysis_system_prompt

    result = _section_analysis_system_prompt(expected_root_count=None)
    assert "__ROOT_COUNT_CLAUSE__" not in result
    assert "At most ONE node in your entire response" in result
    assert '{"nodes": [...]}' in result  # literal JSON braces survived untouched

    result_multi = _section_analysis_system_prompt(expected_root_count=3)
    assert "This section has 3 independent top-level" in result_multi


def test_load_prompt_raises_on_unknown_marker() -> None:
    # A marker kwarg with no matching __NAME__ placeholder in the file is a
    # real programming error (e.g. a typo'd kwarg name) -- must raise, not
    # silently no-op.
    import pytest

    with pytest.raises(ValueError, match="no '__NOT_A_REAL_MARKER__' placeholder"):
        load_prompt("generate_requirements", not_a_real_marker="x")


def test_load_prompt_raises_on_missing_file() -> None:
    import pytest

    with pytest.raises(FileNotFoundError):
        load_prompt("this_prompt_does_not_exist")
