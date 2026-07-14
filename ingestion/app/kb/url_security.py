"""URL-security helpers for the Microsoft Graph document-ingest path.

Pure functions, no network I/O. Guard a user-supplied SharePoint/OneDrive
sharing URL against SSRF, cap downloaded file size, and confirm downloaded
bytes actually look like a supported document type before parsing.
"""

import ipaddress
from urllib.parse import urlparse

ALLOWED_HOST_SUFFIXES: tuple[str, ...] = (
    "sharepoint.com",
    "onedrive.com",
    "sharepoint.us",
    "onedrive.live.com",
    "1drv.ms",  # OneDrive short-link host; Graph resolves it to the real item
)

MAX_FILE_SIZE_BYTES: int = 50 * 1024 * 1024


def validate_share_url(url: str) -> None:
    """Raise ValueError unless the URL is a safe SharePoint/OneDrive share link."""
    if not url.startswith("http"):
        raise ValueError(f"unsupported URL scheme: {url!r}")

    parsed = urlparse(url)
    host = parsed.hostname or ""
    if not host:
        raise ValueError(f"URL has no hostname: {url!r}")

    # Anchor the suffix match at a domain-label boundary: the host must equal
    # an allowed domain or be a subdomain of one. A raw str.endswith would let
    # attacker-registered lookalikes through (e.g. "fakeonedrive.com".endswith
    # ("onedrive.com") is True) — a real host-spoofing / SSRF bypass.
    host_lower = host.lower()
    if not any(
        host_lower == suffix or host_lower.endswith("." + suffix)
        for suffix in ALLOWED_HOST_SUFFIXES
    ):
        raise ValueError(
            f"host {host!r} is not an allowed SharePoint/OneDrive domain"
        )

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None

    if ip is not None and (ip.is_private or ip.is_loopback or ip.is_link_local):
        raise ValueError(f"host {host!r} resolves to a private/internal address")


def verify_supported_content(filename: str, content: bytes) -> None:
    """Raise ValueError if content's magic bytes don't match the filename extension."""
    ext = "." + filename.lower().rsplit(".", 1)[-1]

    if ext == ".pdf":
        if not content.startswith(b"%PDF"):
            raise ValueError("expected PDF magic bytes b'%PDF', got mismatched content")
    elif ext in (".docx", ".xlsx"):
        if not content.startswith(b"PK\x03\x04"):
            raise ValueError(
                "expected ZIP container magic bytes b'PK\\x03\\x04', got mismatched content"
            )
    elif ext in (".txt", ".md"):
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"content is not valid UTF-8 for {ext} file") from exc
    else:
        raise ValueError(f"unsupported file type: {ext}")
