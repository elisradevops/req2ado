from __future__ import annotations

import httpx
from pydantic import BaseModel


class SharePointFile(BaseModel):
    name: str
    server_relative_url: str


class SharePointClient:
    """Fetches file listings and content from a SharePoint site via its
    REST API, using a literal bearer token (Authorization: Bearer <token>)
    — the user's confirmed real-world SharePoint access model (see
    docs/docgen-connection-pattern.md's SharePoint Online/bearer path).
    NTLM on-prem auth is explicitly out of scope for this phase."""

    def __init__(self, site_url: str, bearer_token: str) -> None:
        self._site_url = site_url.rstrip("/")
        self._bearer_token = bearer_token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._bearer_token}",
            "Accept": "application/json;odata=verbose",
        }

    def list_files(self, library: str, folder: str) -> list[SharePointFile]:
        server_relative_url = f"{library}/{folder}".strip("/")
        url = f"{self._site_url}/_api/web/GetFolderByServerRelativeUrl('{server_relative_url}')/Files"
        with httpx.Client(timeout=60.0) as client:
            response = client.get(url, headers=self._headers())
        response.raise_for_status()
        entries = response.json()["d"]["results"]
        return [SharePointFile(name=entry["Name"], server_relative_url=entry["ServerRelativeUrl"]) for entry in entries]

    def fetch_file_bytes(self, server_relative_url: str) -> bytes:
        url = f"{self._site_url}/_api/web/GetFileByServerRelativeUrl('{server_relative_url}')/$value"
        with httpx.Client(timeout=60.0) as client:
            response = client.get(url, headers=self._headers())
        response.raise_for_status()
        return response.content
