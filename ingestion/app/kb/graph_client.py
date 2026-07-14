from __future__ import annotations

import base64

import httpx
from pydantic import BaseModel


class GraphDriveItem(BaseModel):
    id: str
    name: str
    mime_type: str | None
    size: int


class GraphApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def encode_share_id(url: str) -> str:
    return "u!" + base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")


def _error_for_status(status: int) -> GraphApiError:
    messages = {
        401: "token expired or invalid",
        403: "token lacks permission for this file",
        404: "file not found at the sharing link",
    }
    message = messages.get(status, f"Graph API error: {status}")
    return GraphApiError(status, message)


class GraphClient:
    """Fetches a single document from a SharePoint/OneDrive sharing URL via
    the Microsoft Graph /shares endpoint, using a bearer token supplied at
    construction."""

    def __init__(self, token: str, base_url: str) -> None:
        if not token:
            raise ValueError("no SharePoint/Graph token configured")
        self.token = token
        self.base_url = base_url.rstrip("/")

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def _get(self, request_url: str) -> httpx.Response:
        # Wrap transport-level failures (timeout, connection reset, DNS) as a
        # 502-class GraphApiError so the route maps them to a clean HTTP 502
        # instead of leaking an opaque 500. httpx error messages carry the
        # request URL but never the Authorization header, so no token leak.
        try:
            with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                return client.get(request_url, headers=self._headers())
        except httpx.HTTPError as exc:
            raise GraphApiError(502, "could not reach Microsoft Graph") from exc

    def get_drive_item(self, url: str) -> GraphDriveItem:
        share_id = encode_share_id(url)
        request_url = f"{self.base_url}/shares/{share_id}/driveItem"
        response = self._get(request_url)
        if response.status_code != 200:
            raise _error_for_status(response.status_code)
        body = response.json()
        return GraphDriveItem(
            id=body["id"],
            name=body["name"],
            mime_type=body.get("file", {}).get("mimeType"),
            size=body.get("size", 0),
        )

    def fetch_content(self, url: str) -> bytes:
        share_id = encode_share_id(url)
        request_url = f"{self.base_url}/shares/{share_id}/driveItem/content"
        response = self._get(request_url)
        if response.status_code != 200:
            raise _error_for_status(response.status_code)
        return response.content
