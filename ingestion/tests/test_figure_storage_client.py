import base64
import io
import json

import httpx
import pytest
from PIL import Image

from app.vision.figure_storage_client import OrchestratorFigureFileClient, compress_figure_for_storage


def _make_png(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color=(10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_compress_figure_for_storage_returns_png_bytes_and_mime_type() -> None:
    result = compress_figure_for_storage(_make_png(100, 50))
    assert result is not None
    compressed_bytes, mime_type = result
    assert mime_type == "image/png"
    assert Image.open(io.BytesIO(compressed_bytes)).format == "PNG"


def test_compress_figure_for_storage_downsizes_a_long_edge_over_the_cap() -> None:
    result = compress_figure_for_storage(_make_png(4000, 1000))
    assert result is not None
    compressed_bytes, _ = result
    with Image.open(io.BytesIO(compressed_bytes)) as image:
        assert max(image.width, image.height) <= 1800


def test_compress_figure_for_storage_leaves_a_small_image_unresized() -> None:
    result = compress_figure_for_storage(_make_png(100, 50))
    assert result is not None
    compressed_bytes, _ = result
    with Image.open(io.BytesIO(compressed_bytes)) as image:
        assert (image.width, image.height) == (100, 50)


def test_compress_figure_for_storage_returns_none_for_undecodable_bytes() -> None:
    # Not a real EMF signature, just arbitrary bytes Pillow can't open --
    # stands in for the real vector-metafile case (see emf_converter.py).
    assert compress_figure_for_storage(b"not an image") is None


def test_store_posts_base64_bytes_and_mime_type_with_bearer_auth() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["authorization"] = request.headers["authorization"]
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"stored": True})

    client = OrchestratorFigureFileClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    client.store("job-1", "f3", b"compressed-png-bytes", "image/png")

    assert captured["path"] == "/jobs/job-1/figures/f3"
    assert captured["authorization"] == "Bearer test-bearer"
    assert captured["body"] == {
        "bytes": base64.b64encode(b"compressed-png-bytes").decode("ascii"),
        "mimeType": "image/png",
    }


def test_store_raises_on_non_200_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(413, json={"message": "too large"})

    client = OrchestratorFigureFileClient(base_url="http://orchestrator.internal", bearer_token="test-bearer")
    client._transport = httpx.MockTransport(handler)

    with pytest.raises(httpx.HTTPStatusError):
        client.store("job-1", "f3", b"bytes", "image/png")
