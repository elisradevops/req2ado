from __future__ import annotations

import base64
import hashlib
import json
from typing import NamedTuple

import httpx
from json_repair import repair_json

from app.config import settings

# Sourced from settings (config.py) rather than a bare literal so it can be
# tuned per-deployment without a code change -- see config.py's own doc
# comment for why 590s (just under the orchestrator's own 600s LLM timeout).
_VISION_REQUEST_TIMEOUT_SECONDS = settings.vision_request_timeout_seconds


class FigureVisionResult(NamedTuple):
    """Structured result of describe_figure -- replaces the old free-text
    caption + hoped-for magic-string sentinel with schema-constrained
    output. `significant=False` means "don't show this figure to the model
    at all" (main.py's caller sets Figure.caption=None in that case, reusing
    the existing caption=None -> omitted-from-context convention unchanged).

    `title` (Task 7): a short noun-phrase name for this figure, distinct
    from `description`'s prose -- used ONLY as a fallback for Figure.name
    when the document itself provides no "Figure N: Title" caption line
    (see figure_utils.py's extract_figure_title); the document's own
    caption always wins when both exist (main.py patches this in, not
    here). None when the model omitted it or the figure isn't significant
    -- an insignificant figure gets no name from either source."""

    significant: bool
    description: str
    title: str | None = None


_FIGURE_SIGNIFICANCE_SCHEMA = {
    "type": "object",
    "properties": {
        "significant": {
            "type": "boolean",
            "description": "True if this figure has real technical/informational content relevant to understanding the document; false for decorative images, logos, or blank/placeholder graphics.",
        },
        "description": {
            "type": "string",
            "description": (
                "2-4 plain sentences of flowing prose (not a hard cap on "
                "content, a cap on FORMAT). Be concrete and specific to THIS "
                "figure: name the actual labeled parts, real dimensions/"
                "values, and real connector/pin counts visible in the image "
                "-- do not fall back to a generic template description that "
                "could apply to any similar-looking drawing. For a "
                "multi-view drawing, summarize what the views collectively "
                "show in prose -- do NOT enumerate each view as its own "
                "labeled section. No markdown (no headers, no bold, no "
                "bullet/numbered lists), no LaTeX/math notation. Empty if "
                "not significant."
            ),
        },
        "title": {
            "type": "string",
            "description": (
                "A short noun-phrase title for this figure (a few words, "
                "not a sentence) -- e.g. 'CubeConnect PCB Interior View', "
                "not 'This is a photo of...'. Used only as a fallback name "
                "when the document itself provides no caption for this "
                "figure. Empty if not significant."
            ),
        },
    },
    "required": ["significant", "description"],
}


def _build_prompt(document_context: str | None) -> str:
    # Real live incident history behind this exact wording (2 rounds):
    # (1) the deployed vision model, for a multi-view engineering drawing,
    # ignored a soft "one or two sentences" instruction and produced a
    # markdown breakdown per view (a header + several full sentences each)
    # -- long enough to get cut off mid-JSON by the orchestrator's own
    # max_tokens cap, producing a schema-valid but content-truncated
    # caption. (2) The first fix over-corrected: forcing "EXACTLY ONE OR
    # TWO sentences" + "the SINGLE most important fact" pushed the model
    # into a narrow, repetitive template ("The drawing depicts an
    # enclosure featuring..." reused near-verbatim across unrelated
    # figures) instead of describing each figure's own actual content --
    # confirmed live across a real 110-figure run. The fix is bounding
    # FORMAT (no markdown/lists/per-view enumeration -- the actual source
    # of the truncation-causing length), not sentence COUNT -- a few
    # sentences of concrete, specific plain prose stays well short of any
    # reasonable token cap on its own; forcing it shorter just made it
    # generic instead of forcing it complete.
    base = (
        "Describe this figure or diagram in 2-4 sentences of plain prose. "
        "Be concrete and specific: name the actual labeled parts, real "
        "dimensions/values, and real connector/pin counts visible in THIS "
        "image -- do not reuse a generic description that could equally "
        "apply to any similar-looking drawing. For a multi-view drawing, "
        "summarize what the views collectively show in flowing prose -- do "
        "NOT enumerate each view as its own labeled section or list. Do "
        "NOT use markdown formatting (no headers, no bold, no bullet or "
        "numbered lists) and do NOT use LaTeX/math notation -- plain prose "
        "only. Judge whether the figure has genuine informational content "
        "worth including, or whether it is decorative (a logo, a colored "
        "placeholder block, a blank divider). Also give a short noun-"
        "phrase title for the figure (a few words, for use as a display "
        "label) -- not a sentence, not a restatement of the description."
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


# Real gap this closes, found during review (not live-reproduced, but
# structurally certain): main.py's figure-caption cache has NO prompt-
# version component in its key at all -- keyed only on image bytes +
# document_context. This prompt's OWN wording changed twice in one real
# debugging session (once for truncation, once for over-corrected
# brevity), and each time required a manual `redis-cli DEL figcap:*`
# before re-testing, or the 1-week TTL would have silently kept serving
# captions generated under the OLD wording. In a real deployment (no one
# manually flushing Redis), shipping a prompt fix would not actually take
# effect on a previously-ingested document until either its cache entries
# individually expire or the whole week elapses -- exactly the kind of
# "the fix looks deployed but isn't observably active" gap this session's
# other bugs kept turning out to be. Derived from the actual prompt/schema
# TEXT (hashed), not a manually-bumped literal -- so the NEXT prompt
# wording change invalidates old cache entries automatically, with no
# separate version-bump step to remember or forget.
PROMPT_VERSION = hashlib.sha256(
    (_build_prompt(None) + json.dumps(_FIGURE_SIGNIFICANCE_SCHEMA, sort_keys=True)).encode("utf-8")
).hexdigest()[:12]


def _strip_degenerate_continuation(description: str) -> str:
    """Truncates at the first markdown code-fence marker ("```") -- real
    live incident this closes: 2 of 42 real captions in a completed job
    came back with their genuine content repeated near-verbatim, trailed
    by a broken continuation fragment like "```json {" -- all of it
    INSIDE the JSON string's own content (response_format's schema
    enforcement constrains structure, not what a model chooses to put in a
    string field, so this is a content-quality/repetition-loop problem,
    not a parsing bug). A real caption can never legitimately contain a
    code fence -- the prompt explicitly forbids markdown -- so any
    occurrence is unambiguous evidence of degenerate continuation, safe to
    cut at deterministically. This is a backstop for the WORST visible
    symptom (a broken, half-written fragment leaking into user-facing
    text), not a guarantee against milder in-content repetition -- see
    OpenWebUiClient.vision()'s frequency_penalty for the actual root-cause
    mitigation."""
    fence_index = description.find("```")
    return description if fence_index == -1 else description[:fence_index].rstrip()


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
            description = _strip_degenerate_continuation(raw_description if isinstance(raw_description, str) else "")
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
            # Task 7: title is optional (not in the schema's `required`
            # list -- a model that omits it must not fail the whole parse,
            # unlike significant/description above). Any non-string value
            # (missing, null, wrong type) normalizes to None, same
            # fail-open stance as raw_description above; an empty/
            # whitespace-only title also normalizes to None rather than
            # being used as a blank display label.
            raw_title = parsed.get("title")
            title = raw_title.strip() if isinstance(raw_title, str) and raw_title.strip() else None
            return FigureVisionResult(significant=parsed["significant"], description=description, title=title)
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
