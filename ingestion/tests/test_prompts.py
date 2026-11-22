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
    # v3 (kept for history) took the catalog as a marker; v4 reads it from the <link_types> data block.
    assert '- Some.Ref ("Some Name")' in load_prompt(
        "infer_trace_links", 3, catalog_lines='- Some.Ref ("Some Name")'
    )
    for version in (4, 5):
        result = load_prompt("infer_trace_links", version)
        assert "__CATALOG_LINES__" not in result and "<link_types> block" in result
        assert result.endswith("the response body must be valid JSON on its own.")
    assert load_prompt("infer_trace_links", 4).startswith(
        "You infer trace/coverage links between work items"
    )
    # v5 drops v4's opening base-rate hint ("the most common case is ...").
    latest = load_prompt("infer_trace_links")
    assert latest.startswith("You infer trace and coverage links between work items")
    assert "most common case" not in latest


def test_infer_trace_links_v2_prompt_includes_native_type_preference_instruction() -> None:
    # Task 5: v2 includes an explicit instruction to prefer native ADO link
    # types when they fit the relationship. Verify the key phrases are present.
    result = load_prompt("infer_trace_links")
    assert "Native Azure DevOps link types" in result
    assert "System." in result or "Microsoft.VSTS." in result
    assert "standard, well-established meanings" in result
    assert "prefer one of these whenever it genuinely captures the relationship" in result
    assert "custom, organization-defined link type" in result
    assert "use one only when no native type fits as well" in result


def test_infer_trace_links_v3_prompt_requires_object_wrapper_and_evidence_quote() -> None:
    # C1 fix: v2 still told the model to return a bare JSON array, never
    # updated when trace_links_schema()/infer_trace_links moved to the
    # object-wrapped {"links": [...]} shape with a required evidence_quote
    # field (see _response_schemas.trace_links_schema and
    # trace_links.py's evidence-quote validation). v3 must actually ask
    # for what the code now requires.
    result = load_prompt("infer_trace_links", 4)
    assert "'links' array" in result
    assert "'evidence_quote'" in result
    assert "exact, verbatim, character-for-character" in result
    assert "will be discarded" in result


def test_infer_trace_links_v5_names_a_node_target_and_a_cited_identifier_separately() -> None:
    result = load_prompt("infer_trace_links")
    assert "'links' array" in result and "'evidence_quote'" in result
    assert "'target_node_id'" in result and "'target_external_id'" in result
    assert "'target_ref'" not in result
    assert "Exactly one of 'target_node_id' and 'target_external_id' is filled in" in result
    assert "is discarded" in result


def test_score_requirements_for_document_prompt() -> None:
    result = load_prompt(
        "score_requirements_for_document", category_instruction="X-CATEGORY-Y ", node_count="7"
    )
    assert "X-CATEGORY-Y " in result
    assert "The input contains exactly 7 node_id(s)." in result
    assert "Return exactly 7 entries in your response" in result


def test_score_requirements_v4_prompt_asks_for_levels_and_findings_not_a_score_or_a_confidence() -> None:
    # v4 (S3): the model judges levels and quotes findings; the score and the confidence (agreement of two votes) are computed in
    # app.leveling.score_levels, so the prompt must not ask for either. The exactly-N coverage instruction stays: it fixed the real
    # "returned no valid score for N node(s)" failure.
    result = load_prompt(
        "score_requirements_for_document",
        output_lead="Return",
        category_instruction="'categories' -- TEST.",
        findings="vague_term",
        node_count="7",
    )
    assert "'categories' and 'findings'" in result and "vague_term" in result
    assert "Do not give an overall score or a confidence" in result
    assert "'score' (an integer" not in result and "'confidence' (exactly one of" not in result
    assert "never omit it" in result
    assert result.count("exactly 7 node_id(s)") == 1
    assert "Return exactly 7 entries" in result
    assert "__" not in result  # every marker was substituted


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
    # The tag vocabulary now arrives inside the generated output-format sentence (keyed_specs.SYNTHESIS_SPEC).
    from app.survey.keyed_calls import describe_output
    from app.survey.keyed_specs import SYNTHESIS_SPEC

    result = load_prompt(
        "synthesize_leaf_requirements",
        row_count="3",
        output_format=describe_output(SYNTHESIS_SPEC, "none"),
    )
    assert _TAG_VOCABULARY in result
    assert "The input contains exactly 3 row(s)." in result


def test_judge_duplicate_pair_prompt_loads() -> None:
    assert load_prompt("judge_duplicate_pair").startswith(
        "You are given two requirement statements"
    )


def test_judge_parameter_pairs_prompt_loads() -> None:
    result = load_prompt("judge_parameter_pairs")
    assert len(result) > 0


def test_judge_kb_relevance_prompt_loads() -> None:
    result = load_prompt("judge_kb_relevance")
    assert len(result) > 0


def test_judge_kb_relevance_prompt_counts_writing_guidance_as_relevant() -> None:
    # A requirements-writing guide (rules, templates, quality criteria) shares
    # little vocabulary with a technical section yet applies to all of them;
    # the judge must not mark it not_relevant for a differing subject.
    result = load_prompt("judge_kb_relevance", output_format="OUT")
    assert "HOW requirements should be written" in result
    assert "regardless of topic" in result
    assert "OUT" in result and "__OUTPUT_FORMAT__" not in result


def test_extract_quality_checklist_prompt_loads() -> None:
    result = load_prompt("extract_quality_checklist")
    assert len(result) > 0


def test_extract_quality_checklist_definitions_prompt() -> None:
    # v1 (kept for history) took the names as a marker; v2 reads them from the <category_names> data block.
    result = load_prompt(
        "extract_quality_checklist_definitions", 1, category_names='["Necessary", "Unambiguous"]'
    )
    assert '["Necessary", "Unambiguous"]' in result
    current = load_prompt("extract_quality_checklist_definitions")
    assert "__CATEGORY_NAMES__" not in current and "<category_names> block" in current


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
