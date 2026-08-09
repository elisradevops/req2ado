from __future__ import annotations

import base64
import io

import httpx
from PIL import Image

_FIGURE_STORE_REQUEST_TIMEOUT_SECONDS = 30.0

# These are line diagrams/schematics captured for later ADO attachment, not
# photos -- a long edge beyond ~1800px buys no readability for a diagram and
# just inflates Postgres storage (see JobFigureFile's own Prisma model
# comment for the full lifecycle/storage-budget reasoning).
_MAX_LONG_EDGE_PX = 1800


def compress_figure_for_storage(image_bytes: bytes) -> tuple[bytes, str] | None:
    """Re-encodes a raster figure as a resized, optimized PNG for storage in
    JobFigureFile -- always PNG regardless of the source format: these are
    line diagrams/schematics, not photos, so PNG's palette optimization
    shrinks them hard without the blur JPEG would add on fine text/lines.
    Operates on the SAME original bytes handed to _describe_figure, not its
    (vision-only) EMF/WMF-converted copy -- returns None if Pillow can't
    open the bytes at all (a vector EMF/WMF metafile Pillow has no built-in
    support for, see emf_converter.py's own docstring, or any other format
    this can't decode). Storage is best-effort: a figure that can't be
    compressed simply doesn't get attachment capability, it never fails the
    describe_figure call it's piggybacking on."""
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception:
        return None
    if image.width > _MAX_LONG_EDGE_PX or image.height > _MAX_LONG_EDGE_PX:
        scale = _MAX_LONG_EDGE_PX / max(image.width, image.height)
        new_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(new_size, Image.LANCZOS)
    if image.mode not in ("RGB", "RGBA", "L", "P"):
        image = image.convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), "image/png"


class OrchestratorFigureFileClient:
    """Calls the orchestrator's internal POST /jobs/:jobId/figures/:figureId
    route to persist a compressed figure's bytes (JobFigureFile) -- same
    bearer-guarded service-to-service convention as OrchestratorVisionClient/
    OrchestratorEmbedClient, never reachable from a browser session."""

    def __init__(self, base_url: str, bearer_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer_token = bearer_token
        self._transport: httpx.BaseTransport | None = None  # test-only injection seam

    def store(self, job_id: str, figure_id: str, image_bytes: bytes, mime_type: str) -> None:
        """Raises on any non-2xx/network failure -- the caller
        (main.py's _describe_figure_with_progress) is the one that decides
        this is best-effort and swallows the exception, same division of
        responsibility as every other Orchestrator*Client in this package."""
        with httpx.Client(transport=self._transport, timeout=_FIGURE_STORE_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{self._base_url}/jobs/{job_id}/figures/{figure_id}",
                json={"bytes": base64.b64encode(image_bytes).decode("ascii"), "mimeType": mime_type},
                headers={"Authorization": f"Bearer {self._bearer_token}"},
            )
        response.raise_for_status()
