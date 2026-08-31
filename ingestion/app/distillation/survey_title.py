from __future__ import annotations

from typing import Protocol

from app.distillation.title import extract_baseline_title

# Status (300553, corrected -- this module now DOES have a real caller):
# titles from the batched whole-document generation call (see
# llm_leveling.py's build_survey_tree/_author_branch_content) stand as-is in
# the common case, but a title that's too generic/short
# (distillation.title.title_is_low_quality) is now corrected via
# distill_survey_title once the node's real description text exists to
# distill FROM -- OrchestratorLlmClient.distill_title is the real
# implementation, wired the same way as every other TitleTagClient/
# SynthesisClient/ParentSummaryClient-style capability in this codebase (one
# client, many Protocols). See _author_branch_content for the actual gate.


class TitleDistillationClient(Protocol):
    """Interface for SURVEY-mode title distillation, backed by
    OrchestratorLlmClient.distill_title (a real /llm/chat call through the
    orchestrator's redaction-proxy). Matches the runtime prompt contract
    documented in docs/architecture.md: 'item text + 256 limit -> single-line
    title (first sentence if descriptive, else concise summary/paraphrase);
    enforce <=256.'"""

    def distill_title(self, text: str, max_length: int, user_id: str | None = None) -> str: ...


def distill_survey_title(
    text: str, client: TitleDistillationClient, max_length: int = 256, user_id: str | None = None,
) -> str:
    """SURVEY-mode title distillation: delegates to the injected client (a
    real LLM chat call, once the orchestrator's redaction-proxy exists), then
    defensively re-truncates the result via extract_baseline_title. This
    guarantees the schema's title max_length constraint holds even if the
    client ignores the max_length it was given — never trust an external
    (eventually LLM-backed) response to self-enforce a hard limit."""
    distilled = client.distill_title(text, max_length, user_id=user_id)
    return extract_baseline_title(distilled, max_length)
