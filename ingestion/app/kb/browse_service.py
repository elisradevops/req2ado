from __future__ import annotations

from pydantic import BaseModel

from app.kb.graph_client import GraphClient
from app.kb.url_security import validate_share_url


class FolderChildSummary(BaseModel):
    id: str
    name: str
    mime_type: str | None
    size_bytes: int
    is_folder: bool
    # Present only for folders -- needed to descend into this child via
    # browse_children (Graph's by-id children endpoint, unlike the
    # by-share-link root listing, addresses a folder by drive_id + id).
    drive_id: str | None = None
    # Present only for files -- Graph's own pre-signed, short-lived download
    # URL (see GraphFolderChild.download_url). Lets a caller ingest exactly
    # this file (POST /kb/ingest-item) without having that file's own
    # sharing link, which browsing alone never produces.
    download_url: str | None = None


def browse_shared_folder(url: str, graph_client: GraphClient) -> list[FolderChildSummary]:
    """Lists the immediate children of a shared folder, purely for display
    -- no ingest side effects, no recursion (the caller re-calls
    browse_children per folder the user actually expands, so opening a tree
    view never pays the cost of walking a folder nobody looks at)."""
    validate_share_url(url)
    children = graph_client.list_folder_children(url)
    return [
        FolderChildSummary(
            id=child.id,
            name=child.name,
            mime_type=child.mime_type,
            size_bytes=child.size,
            is_folder=child.is_folder,
            drive_id=child.drive_id if child.is_folder else None,
            download_url=child.download_url if not child.is_folder else None,
        )
        for child in children
    ]


def browse_subfolder(drive_id: str, item_id: str, graph_client: GraphClient) -> list[FolderChildSummary]:
    """Same as browse_shared_folder, for a subfolder reached during tree
    expansion -- addressed by drive_id + item_id (returned on each folder
    child above), not a share URL."""
    children = graph_client.list_children_by_id(drive_id, item_id)
    return [
        FolderChildSummary(
            id=child.id,
            name=child.name,
            mime_type=child.mime_type,
            size_bytes=child.size,
            is_folder=child.is_folder,
            drive_id=child.drive_id if child.is_folder else None,
            download_url=child.download_url if not child.is_folder else None,
        )
        for child in children
    ]
