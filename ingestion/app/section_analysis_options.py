# ingestion/app/section_analysis_options.py
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, kw_only=True, slots=True)
class SectionAnalysisOptions:
    """The prompt-STEERING half of a SectionAnalysisClient section-analysis
    call (see app.leveling.llm_leveling.SectionAnalysisClient), bundled so
    the same six parameters stop being restated verbatim on every
    analyze_section* method of the Protocol, of its real implementation
    (app.survey.orchestrator_llm_client.OrchestratorLlmClient) and of every
    explicit-signature test double.

    Deliberately holds ONLY the six steering hints. `section_text` (the
    payload), `kb_context` (which distinguishes the pre-computed fallback
    path from the agentic one) and `retrieve_fn`/`list_documents_fn`/
    `read_document_fn`/`read_other_section_fn` (injected capability
    closures, individually toggled to decide which tools the model is
    offered) all stay standalone parameters -- they are different KINDS of
    input, and bundling them would obscure exactly the distinctions those
    calls' own tests exercise.

    Every field steers a STRUCTURAL decision and every one is consumed only
    by prompt-suffix assembly plus the response cache key -- none of them
    changes control flow inside the client:

    - `whole_document` -- the model is analyzing the ENTIRE document in one
      call (build_survey_tree's whole-doc gate found it fits budget), not
      one small section; appends a coverage hint, because the base prompt's
      synthesis-maximizing instructions otherwise drive over-consolidation
      when applied once to hundreds of blocks instead of once per branch.
    - `topic_count` -- the document's real heading count, making that hint
      quantitative; confirmed live that a qualitative-only reminder does
      NOT change model behavior.
    - `table_group_hints` -- (label, suggested_type) pairs for this
      section's own qualifying table groups (see
      app.leveling.table_groups.qualifying_table_groups): names WHICH
      groups must each get their own node AND which work-item type each
      should become, so the model isn't left guessing Feature vs Feature vs
      Epic.
    - `expected_root_count` -- count of independent top-level table groups
      with no common ancestor; lets the model know a real multi-root
      document is expected. None or <2 (the common case) preserves the
      exact single-root prompt wording, so omitting it is byte-identical to
      before this parameter existed.
    - `requirement_row_hints` -- (code, label) pairs for this section's own
      qualifying requirement-list table rows (see
      app.leveling.requirement_rows.qualifying_requirement_rows): names
      which source rows carry their own literal requirement identifier and
      must therefore each become their own Requirement node.
    - `heading_type_hints` -- (title, type) pairs for this section's own
      real heading outline (see app.leveling.heading_outline
      .heading_outline_entries): names each Epic/Feature-typed heading and
      the type it must become, derived from the document's own RELATIVE
      nesting shape, never an absolute heading level.

    Every field's default is the default the parameter it replaced already
    had -- those defaults are a documented contract ("omitting it preserves
    today's exact wording"), not convenience -- so a caller with nothing to
    steer passes nothing at all.

    `kw_only=True` is what makes six defaulted fields safe: a seventh hint
    appended later can never silently shift a positional argument, because
    positional construction does not exist. `frozen=True` makes the shared
    DEFAULT_SECTION_ANALYSIS_OPTIONS singleton safe to use as a parameter
    default. Note that `frozen` is shallow -- the two list-valued fields
    are still mutable in place. Nothing in this codebase mutates them (both
    real call sites build them by comprehension and only ever read them),
    and they are deliberately left as `list` rather than converted to
    `tuple`, which would churn both call sites for no behavioral gain."""

    whole_document: bool = False
    topic_count: int | None = None
    table_group_hints: list[tuple[str, str]] | None = None
    expected_root_count: int | None = None
    requirement_row_hints: list[tuple[str, str]] | None = None
    heading_type_hints: list[tuple[str, str]] | None = None


# Shared default for every analyze_section* method's `options` parameter.
# Safe to share precisely because the dataclass is frozen.
DEFAULT_SECTION_ANALYSIS_OPTIONS = SectionAnalysisOptions()
