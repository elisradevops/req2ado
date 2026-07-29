from __future__ import annotations

import base64

import httpx

_VISION_REQUEST_TIMEOUT_SECONDS = 300.0

# A fixed, literal sentinel the model must return verbatim (nothing else)
# when a figure has no real technical content -- lets the dropped-block
# coverage check (llm_leveling.py) reliably skip these figures via an exact
# string match instead of pattern-matching whichever free-form "nothing
# here" sentence the model happens to produce. main.py translates this back
# to human-readable copy before it reaches narration/the UI.
NO_TECHNICAL_CONTENT_SENTINEL = "NO_TECHNICAL_CONTENT"
_DESCRIBE_FIGURE_PROMPT = (
    "Describe this figure or diagram in one or two sentences, focusing on any "
    "technical content (components, connections, values, labeled parts). If "
    f"the image contains no discernible technical content, respond with "
    f"exactly the single word {NO_TECHNICAL_CONTENT_SENTINEL} and nothing else."
)


class OrchestratorVisionClient:
    """Calls the orchestrator's POST /llm/vision proxy -- NEVER calls Open
    WebUI/Ollama directly, same 'backend proxy, redact-first' boundary as
    every other real LLM client in this codebase. Mirrors
    OrchestratorEmbedClient's structure and test-injection seam."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def describe_figure(self, image_bytes: bytes, mime_type: str | None = None) -> str:
        """`mime_type` (e.g. 'image/jpeg'), when supplied, tells the
        orchestrator's real content-type instead of its pre-existing
        hardcoded 'image/png' default -- harmless for a docx-embedded PNG
        figure (every existing caller omits it, unchanged behavior), but
        needed for a directly-uploaded non-PNG image (see
        app/loaders/image_loader.py)."""
        with httpx.Client(transport=self._transport, timeout=_VISION_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/llm/vision",
                json={
                    "prompt": _DESCRIBE_FIGURE_PROMPT,
                    "images": [base64.b64encode(image_bytes).decode("ascii")],
                    **({"mimeType": mime_type} if mime_type else {}),
                },
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
        return response.json()["description"]
