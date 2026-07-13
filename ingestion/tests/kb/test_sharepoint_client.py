import httpx
import pytest

from app.kb.sharepoint_client import SharePointClient


def _transport_returning(json_body: dict, expected_auth: str) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == expected_auth
        return httpx.Response(200, json=json_body)
    return httpx.MockTransport(handler)


def test_list_files_parses_the_sharepoint_rest_response(monkeypatch) -> None:
    body = {"d": {"results": [{"Name": "doc.docx", "ServerRelativeUrl": "/sites/s/Lib/Folder/doc.docx"}]}}
    transport = _transport_returning(body, "Bearer tok-1")

    real_client_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)

    client = SharePointClient(site_url="https://contoso.sharepoint.com/sites/s", bearer_token="tok-1")
    files = client.list_files("Lib", "Folder")

    assert len(files) == 1
    assert files[0].name == "doc.docx"
    assert files[0].server_relative_url == "/sites/s/Lib/Folder/doc.docx"


def test_fetch_file_bytes_returns_the_raw_response_body(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer tok-1"
        return httpx.Response(200, content=b"file bytes")

    transport = httpx.MockTransport(handler)
    real_client_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)

    client = SharePointClient(site_url="https://contoso.sharepoint.com/sites/s", bearer_token="tok-1")
    content = client.fetch_file_bytes("/sites/s/Lib/Folder/doc.docx")

    assert content == b"file bytes"


def test_list_files_raises_on_a_non_2xx_response(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    transport = httpx.MockTransport(handler)
    real_client_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = transport
        real_client_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)

    client = SharePointClient(site_url="https://contoso.sharepoint.com/sites/s", bearer_token="bad-tok")
    with pytest.raises(httpx.HTTPStatusError):
        client.list_files("Lib", "Folder")
