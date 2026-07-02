from __future__ import annotations

from typing import Protocol

from app.distillation.title import extract_baseline_title


class TitleDistillationClient(Protocol):
    """Interface for SURVEY-mode title distillation. No real implementation
    exists in this phase — the orchestrator's LLM redaction-proxy (which
    would host the actual Open WebUI/Ollama call) is separate, not-yet-built
    infrastructure. Matches the runtime prompt contract documented in
    docs/architecture.md: 'item text + 256 limit -> single-line title (first
    sentence if descriptive, else concise summary/paraphrase); enforce
    <=256.' Mirrors llm_leveling.py's LlmLevelingClient pattern (Phase 2)."""

    def distill_title(self, text: str, max_length: int) -> str: ...


def distill_survey_title(text: str, client: TitleDistillationClient, max_length: int = 256) -> str:
    """SURVEY-mode title distillation: delegates to the injected client (a
    real LLM chat call, once the orchestrator's redaction-proxy exists), then
    defensively re-truncates the result via extract_baseline_title. This
    guarantees the schema's title max_length constraint holds even if the
    client ignores the max_length it was given — never trust an external
    (eventually LLM-backed) response to self-enforce a hard limit."""
    distilled = client.distill_title(text, max_length)
    return extract_baseline_title(distilled, max_length)
