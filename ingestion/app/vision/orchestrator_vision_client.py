from __future__ import annotations

import base64
import json
from typing import NamedTuple

import httpx
from json_repair import repair_json

_VISION_REQUEST_TIMEOUT_SECONDS = 300.0


class FigureVisionResult(NamedTuple):
    """Structured result of describe_figure -- replaces the old free-text
    caption + hoped-for magic-string sentinel with schema-constrained
    output. `significant=False` means "don't show this figure to the model
    at all" (main.py's caller sets Figure.caption=None in that case, reusing
    the existing caption=None -> omitted-from-context convention unchanged)."""

    significant: bool
    description: str


_FIGURE_SIGNIFICANCE_SCHEMA = {
    "type": "object",
    "properties": {
        "significant": {
            "type": "boolean",
            "description": "True if this figure has real technical/informational content relevant to understanding the document; false for decorative images, logos, or blank/placeholder graphics.",
        },
        "description": {
            "type": "string",
            "description": "One or two sentences describing the figure's technical content (components, connections, values, labeled parts). Empty or minimal if not significant.",
        },
    },
    "required": ["significant", "description"],
}


def _build_prompt(document_context: str | None) -> str:
    base = (
        "Describe this figure or diagram, focusing on any technical content "
        "(components, connections, values, labeled parts). Judge whether it "
        "has genuine informational content worth including, or whether it is "
        "decorative (a logo, a colored placeholder block, a blank divider)."
    )
    if not document_context:
        return base
    return (
        f"{base}\n\nContext about the document this figure appears in: "
        f"{document_context}\n\nJudge significance relative to THIS document -- "
        "a figure that's decorative in isolation but happens to be labeled "
        "with document-relevant terminology should still be judged on its "
        "own visual content, not on the surrounding context alone."
    )


def _parse_figure_response(raw: str) -> FigureVisionResult | None:
    """Fail-open: any parse failure (malformed JSON, missing fields, wrong
    types) returns None rather than raising -- a bad figure description
    must never fail the whole SURVEY job. None is a DISTINCT outcome from a
    genuinely parsed FigureVisionResult(significant=False, ...): the caller
    (main.py's _describe_figure) must not cache a None result (unknown/
    glitchy, self-heals on retry -- the exact protection the pre-existing
    "never cache a blank result" test already guards), but SHOULD cache a
    real significant=False verdict (a confident, deliberate answer, not an
    ambiguous blank). A significant=True verdict with a BLANK description is
    treated as the same ambiguous outcome as an unparseable response (None) --
    see the inline comment below. Mirrors orchestrator_llm_client.py's own
    defensive parse/repair convention (raw_decode first, json_repair as the
    last resort) without importing that module's narrower, analyze_section-
    specific positional tolerances."""
    for attempt in (raw, None):
        try:
            parsed = json.loads(raw) if attempt is not None else repair_json(raw, return_objects=True)
        except Exception:
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("significant"), bool):
            raw_description = parsed.get("description")
            description = raw_description if isinstance(raw_description, str) else ""
            if parsed["significant"] and not description.strip():
                # significant=True with a blank/whitespace-only description is
                # the exact cache-poisoning state a confirmed live incident
                # produced (an AirPro document whose 39 figures were all blank
                # for a week): well-formed enough to parse, useless as a
                # caption, indistinguishable from a model glitch -- and the
                # `"description": null` -> "" coercion just above manufactures
                # it from a partially-compliant response. Folded into the SAME
                # None outcome as a totally unparseable response so the single
                # "don't cache an ambiguous result" rule in main.py's
                # _describe_figure covers both cases -- one code path, one
                # place that rule lives, instead of a second parallel guard.
                # A significant=False verdict with a blank description is NOT
                # ambiguous (the schema's own `description` field says it may
                # be empty when not significant) and is returned -- and cached
                # -- normally.
                return None
            return FigureVisionResult(significant=parsed["significant"], description=description)
    return None


class OrchestratorVisionClient:
    """Calls the orchestrator's POST /llm/vision proxy -- NEVER calls Open
    WebUI/Ollama directly, same 'backend proxy, redact-first' boundary as
    every other real LLM client in this codebase. Mirrors
    OrchestratorEmbedClient's structure and test-injection seam."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def describe_figure(
        self, image_bytes: bytes, mime_type: str | None = None, document_context: str | None = None
    ) -> FigureVisionResult | None:
        """`mime_type` (e.g. 'image/jpeg'), when supplied, tells the
        orchestrator's real content-type instead of its pre-existing
        hardcoded 'image/png' default. `document_context` (the whole-
        document AI primer, see pipeline.worker.ts) lets significance be
        judged relative to THIS document, not just in visual isolation --
        omitted (None) produces a figure-only prompt, unchanged from before
        this parameter existed."""
        with httpx.Client(transport=self._transport, timeout=_VISION_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/vision",
                json={
                    "prompt": _build_prompt(document_context),
                    "images": [base64.b64encode(image_bytes).decode("ascii")],
                    "responseSchema": {"name": "figure_significance", "schema": _FIGURE_SIGNIFICANCE_SCHEMA},
                    **({"mimeType": mime_type} if mime_type else {}),
                },
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        return _parse_figure_response(response.json()["description"])
