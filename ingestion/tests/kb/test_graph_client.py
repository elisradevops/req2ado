import base64

import httpx
import pytest

from app.kb.graph_client import GraphApiError, GraphClient, GraphDriveItem, GraphFolderChild, encode_share_id


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


def test_list_folder_children_parses_files_and_folders(monkeypatch) -> None:
    body = {
        "value": [
            {"id": "item-1", "name": "a.docx", "size": 10, "file": {"mimeType": "application/x"}, "@microsoft.graph.downloadUrl": "https://dl/a"},
            {"id": "item-2", "name": "Subfolder", "size": 0, "folder": {"childCount": 1}},
        ]
    }

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers["Authorization"]
        return httpx.Response(200, json=body)

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    children = client.list_folder_children("https://contoso.sharepoint.com/sites/s/folder")

    assert children == [
        GraphFolderChild(id="item-1", name="a.docx", mime_type="application/x", size=10, is_folder=False, download_url="https://dl/a"),
        GraphFolderChild(id="item-2", name="Subfolder", mime_type=None, size=0, is_folder=True, download_url=None),
    ]
    assert "/children" in captured["url"]
    assert captured["auth"] == "Bearer tok-1"


def test_list_folder_children_raises_graph_api_error_on_404(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "not found"})

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(GraphApiError) as excinfo:
        client.list_folder_children("https://contoso.sharepoint.com/sites/s/folder")

    assert excinfo.value.status == 404


def test_fetch_child_content_gets_the_download_url_without_an_auth_header(monkeypatch) -> None:
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["has_auth_header"] = "Authorization" in request.headers
        return httpx.Response(200, content=b"child file bytes")

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    content = client.fetch_child_content("https://contoso.sharepoint.com/_layouts/download.aspx?tempauth=xyz")

    assert content == b"child file bytes"
    # The pre-signed download URL must NOT carry our bearer token — Graph
    # already authorized it via the URL's own embedded token.
    assert captured["has_auth_header"] is False


def test_fetch_child_content_raises_graph_api_error_on_non_200(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "forbidden"})

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(GraphApiError) as excinfo:
        client.fetch_child_content("https://contoso.sharepoint.com/_layouts/download.aspx?tempauth=xyz")

    assert excinfo.value.status == 403


def test_fetch_child_content_rejects_a_private_ip_download_url_without_a_network_call(monkeypatch) -> None:
    # Regression: a tampered/compromised Graph response (or a redirect
    # chain) must not be able to point ingestion at an internal address.
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["count"] += 1
        return httpx.Response(200, content=b"should never be reached")

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(ValueError):
        client.fetch_child_content("http://169.254.169.254/latest/meta-data")

    assert called["count"] == 0


def test_fetch_child_content_rejects_a_non_https_download_url(monkeypatch) -> None:
    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(ValueError):
        client.fetch_child_content("http://contoso.sharepoint.com/_layouts/download.aspx?tempauth=xyz")


def test_list_folder_children_populates_drive_id_from_parent_reference(monkeypatch) -> None:
    body = {
        "value": [
            {
                "id": "item-2",
                "name": "Subfolder",
                "size": 0,
                "folder": {"childCount": 1},
                "parentReference": {"driveId": "drive-xyz"},
            },
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    children = client.list_folder_children("https://contoso.sharepoint.com/sites/s/folder")

    assert children[0].drive_id == "drive-xyz"


def test_list_children_by_id_requests_the_drive_item_children_endpoint(monkeypatch) -> None:
    body = {
        "value": [
            {
                "id": "item-3",
                "name": "nested.pdf",
                "size": 20,
                "file": {"mimeType": "application/pdf"},
                "@microsoft.graph.downloadUrl": "https://dl/nested",
                "parentReference": {"driveId": "drive-xyz"},
            },
        ]
    }

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers["Authorization"]
        return httpx.Response(200, json=body)

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    children = client.list_children_by_id("drive-xyz", "item-2")

    assert children == [
        GraphFolderChild(
            id="item-3",
            name="nested.pdf",
            mime_type="application/pdf",
            size=20,
            is_folder=False,
            download_url="https://dl/nested",
            drive_id="drive-xyz",
        ),
    ]
    assert "/drives/drive-xyz/items/item-2/children" in captured["url"]
    assert captured["auth"] == "Bearer tok-1"


def test_list_children_by_id_raises_graph_api_error_on_404(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "not found"})

    _patch_transport(monkeypatch, httpx.MockTransport(handler))

    client = GraphClient("tok-1", "https://graph.microsoft.com/v1.0")
    with pytest.raises(GraphApiError) as excinfo:
        client.list_children_by_id("drive-xyz", "item-2")

    assert excinfo.value.status == 404
