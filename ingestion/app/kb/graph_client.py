from __future__ import annotations

import base64
import json
import time

import httpx
from pydantic import BaseModel

from app.kb.url_security import validate_fetch_url


def decode_jwt_expiry_seconds(token: str) -> int | None:
    """Best-effort remaining-lifetime read for the KB status strip --
    decodes the JWT `exp` claim WITHOUT verifying the signature (this
    process has no way to verify an AAD-issued token's signature, and
    doesn't need to: the token is only ever used by sending it straight to
    Graph, which does its own verification. This is display-only, to render
    "expires in 47m"). Returns None for a non-JWT/opaque token or any
    malformed segment -- callers must treat that as "unknown", not "expired"."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    padded = payload + "=" * (-len(payload) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(padded))
        exp = claims.get("exp")
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(exp, (int, float)):
        return None
    return max(0, int(exp - time.time()))


class GraphDriveItem(BaseModel):
    id: str
    name: str
    mime_type: str | None
    size: int


class GraphFolderChild(BaseModel):
    id: str
    name: str
    mime_type: str | None
    size: int
    is_folder: bool
    download_url: str | None
    # Populated from Graph's `parentReference.driveId` — needed to descend
    # into this child via list_children_by_id when it's a folder (the
    # by-share-link /shares/{id}/... path only works for the shared root).
    drive_id: str | None = None


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

    def validate(self) -> None:
        """Checks the configured token against Graph's own /me endpoint --
        the cheapest live call that proves the token is both well-formed and
        not yet revoked/expired, without needing a real sharing URL on hand.
        Falls back to /me/drive/root on 403: some app-only tokens carry
        Files.Read but not the delegated User.Read /me needs, and this
        connector only ever needs file access. Raises GraphApiError on
        failure (401/403 -> invalid, other -> 502-class); returns nothing on
        success, since the caller only cares whether this raised."""
        response = self._get(f"{self.base_url}/me")
        if response.status_code == 200:
            return
        if response.status_code == 403:
            fallback = self._get(f"{self.base_url}/me/drive/root")
            if fallback.status_code == 200:
                return
            raise _error_for_status(fallback.status_code)
        raise _error_for_status(response.status_code)

    def list_folder_children(self, url: str) -> list[GraphFolderChild]:
        """Lists the immediate children of a shared folder. Each file child
        carries Graph's own pre-signed `@microsoft.graph.downloadUrl` —
        fetching that URL needs no Authorization header (Graph itself already
        authorized it), so `fetch_child_content` never sends the bearer
        token to that host. Subfolders are listed but not recursed into
        (single-level only, matching the plan's scope)."""
        share_id = encode_share_id(url)
        request_url = f"{self.base_url}/shares/{share_id}/driveItem/children"
        response = self._get(request_url)
        if response.status_code != 200:
            raise _error_for_status(response.status_code)
        return [
            GraphFolderChild(
                id=item["id"],
                name=item["name"],
                mime_type=item.get("file", {}).get("mimeType"),
                size=item.get("size", 0),
                is_folder="folder" in item,
                download_url=item.get("@microsoft.graph.downloadUrl"),
                drive_id=item.get("parentReference", {}).get("driveId"),
            )
            for item in response.json().get("value", [])
        ]

    def list_children_by_id(self, drive_id: str, item_id: str) -> list[GraphFolderChild]:
        """Lists the immediate children of a subfolder reached during
        recursive descent, addressed by drive+item id rather than a share
        link (the /shares/{shareId}/... path only resolves the shared
        root). Same mapping/error handling as list_folder_children."""
        request_url = f"{self.base_url}/drives/{drive_id}/items/{item_id}/children"
        response = self._get(request_url)
        if response.status_code != 200:
            raise _error_for_status(response.status_code)
        return [
            GraphFolderChild(
                id=item["id"],
                name=item["name"],
                mime_type=item.get("file", {}).get("mimeType"),
                size=item.get("size", 0),
                is_folder="folder" in item,
                download_url=item.get("@microsoft.graph.downloadUrl"),
                drive_id=item.get("parentReference", {}).get("driveId"),
            )
            for item in response.json().get("value", [])
        ]

    def fetch_child_content(self, download_url: str) -> bytes:
        # download_url is Graph's own pre-signed URL, already scoped to this
        # specific item — no Authorization header sent (the URL itself
        # carries a short-lived token embedded by Graph, not our bearer
        # token, so nothing of ours leaks to this host). Still validated
        # (https + not a private/loopback/link-local IP) rather than trusted
        # blindly: a tampered/compromised Graph response, or a redirect
        # chain (follow_redirects=True below), must not be able to point
        # ingestion at an internal address.
        validate_fetch_url(download_url)
        try:
            with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                response = client.get(download_url)
        except httpx.HTTPError as exc:
            raise GraphApiError(502, "could not reach Microsoft Graph") from exc
        if response.status_code != 200:
            raise _error_for_status(response.status_code)
        return response.content
