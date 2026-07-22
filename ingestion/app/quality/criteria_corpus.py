from __future__ import annotations

from dataclasses import dataclass

from app.workitem.model import RequirementQualityIssue


@dataclass(frozen=True)
class QualityCriterion:
    issue: RequirementQualityIssue
    text: str


# One retrievable reference document per RequirementQualityIssue value,
# compiled from EARS/INCOSE/ISO/IEC/IEEE-29148 public best practices -- this
# is req2ado's OWN authored checklist, not a reproduction of the licensed
# standard text (which this repo has no rights to redistribute). It exists
# so score_requirements_for_document has explicit, retrievable reference
# material to cite instead of relying solely on the model's own parametric
# "general knowledge of these public standards" (see
# llm_leveling.score_requirements_for_document's prior docstring, which
# flagged this exact gap: "this worktree has no KB/retrieval subsystem to
# ground against instead"). See criteria_retrieval.py for how this corpus is
# embedded and queried.
CRITERIA_CORPUS: list[QualityCriterion] = [
    QualityCriterion(
        RequirementQualityIssue.AMBIGUOUS,
        "A requirement must state a single, unambiguous, verifiable condition. "
        "Vague qualifiers like 'should generally' or 'as appropriate' make a "
        "requirement ambiguous because two reviewers could reach different "
        "conclusions about whether it was satisfied.",
    ),
    QualityCriterion(
        RequirementQualityIssue.NOT_TESTABLE,
        "A requirement must be phrased so a specific, repeatable test procedure "
        "can verify pass or fail. Subjective outcomes like 'the system shall be "
        "reliable' are not testable without a quantified threshold.",
    ),
    QualityCriterion(
        RequirementQualityIssue.COMPOUND,
        "A requirement should state exactly one atomic requirement (EARS style). "
        "Joining multiple conditions with 'and' or 'or' into a single statement "
        "makes it compound, harder to trace to a single test case, and harder "
        "to mark partially satisfied.",
    ),
    QualityCriterion(
        RequirementQualityIssue.MISSING_ACCEPTANCE_CRITERIA,
        "A well-formed requirement includes or clearly implies a measurable "
        "acceptance threshold -- a value, a time bound, a tolerance -- rather "
        "than an open-ended goal with no way to determine when it is met.",
    ),
    QualityCriterion(
        RequirementQualityIssue.VAGUE_TERM,
        "Terms like 'user-friendly', 'fast', 'robust', or 'as needed' have no "
        "objective measure. They must be replaced with a quantified equivalent "
        "(e.g. 'fast' becomes 'within 200ms').",
    ),
    QualityCriterion(
        RequirementQualityIssue.PASSIVE_VOICE,
        "INCOSE style prefers active voice ('the system shall X') over passive "
        "voice ('X shall be done'), because passive voice can obscure which "
        "component or actor is actually responsible for the behavior.",
    ),
    QualityCriterion(
        RequirementQualityIssue.MISSING_RATIONALE,
        "A requirement with a non-obvious constraint -- a specific numeric "
        "threshold, an unusual restriction -- should state why it exists, so a "
        "reviewer can judge whether the constraint still applies if the "
        "surrounding context changes.",
    ),
]
