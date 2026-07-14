import base64

import httpx
import pytest

from app.kb.graph_client import GraphApiError, GraphClient, GraphDriveItem, encode_share_id


def _patch_transport(monkeypatch, transport: httpx.MockTransport) -> None:
    real_client_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)


def test_encode_share_id_round_trips_and_has_no_padding() -> None:
    url = "https://x/y"
    share_id = encode_share_id(url)

    assert share_id.startswith("u!")
    assert "=" not in share_id

    padded = share_id[2:]
    padded += "=" * (-len(padded) % 4)
    decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
    assert decoded == url


def test_graph_client_raises_value_error_without_token() -> None:
    with pytest.raises(ValueError):
        GraphClient("", "https://graph.microsoft.com/v1.0")


def test_get_drive_item_parses_the_200_response(monkeypatch) -> None:
    body = {
        "id": "01ABC",
        "name": "spec.docx",
        "size": 1234,
        "file": {"mimeType": "application/vnd...docx"},
    }

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers["Authorization"]
        return httpx.Response(200, json=body)

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    item = client.get_drive_item("https://contoso.sharepoint.com/sites/s/spec.docx")

    assert item == GraphDriveItem(id="01ABC", name="spec.docx", mime_type="application/vnd...docx", size=1234)
    assert "/shares/u!" in captured["url"]
    assert "/driveItem" in captured["url"]
    assert captured["auth"] == "Bearer tok-1"


def test_get_drive_item_raises_graph_api_error_on_401(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(GraphApiError) as excinfo:
        client.get_drive_item("https://contoso.sharepoint.com/sites/s/spec.docx")

    assert excinfo.value.status == 401


def test_get_drive_item_raises_graph_api_error_on_404(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "not found"})

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(GraphApiError) as excinfo:
        client.get_drive_item("https://contoso.sharepoint.com/sites/s/spec.docx")

    assert excinfo.value.status == 404


def test_fetch_content_returns_raw_bytes_on_200(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer tok-1"
        return httpx.Response(200, content=b"file bytes")

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    content = client.fetch_content("https://contoso.sharepoint.com/sites/s/spec.docx")

    assert content == b"file bytes"


def test_fetch_content_raises_graph_api_error_on_403(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "forbidden"})

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(GraphApiError) as excinfo:
        client.fetch_content("https://contoso.sharepoint.com/sites/s/spec.docx")

    assert excinfo.value.status == 403


def test_transport_failure_maps_to_a_502_graph_api_error(monkeypatch) -> None:
    # A network-level failure (timeout, connection reset, DNS) must surface as
    # a 502-class GraphApiError, not an uncaught httpx error that the route
    # would turn into an opaque 500.
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset")

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(GraphApiError) as excinfo:
        client.get_drive_item("https://contoso.sharepoint.com/sites/s/spec.docx")

    assert excinfo.value.status == 502
    # The token must never appear in the error message.
    assert "tok-1" not in str(excinfo.value)
