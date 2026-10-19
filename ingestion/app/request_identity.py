"""Who is calling, and what document overview rides along, without putting either in a URL.

The orchestrator used to send `user_id` and the whole-document overview (`primer_context`, a model-written summary of
the customer's document) as query parameters of `/ingest` and `/level`. The server's access log records the full URL, so
both ended up in the pod log on every job. They now travel in headers; the query form is still accepted for one release
so an older orchestrator keeps working. The overview can contain any language, so it is base64 of its UTF-8 bytes."""
from __future__ import annotations

import base64
import binascii

USER_ID_HEADER = "X-Req2Ado-User-Id"
PRIMER_HEADER = "X-Req2Ado-Primer-Context"


def resolve_user_id(query_value: str | None, header_value: str | None) -> str | None:
    """The header wins; an empty header counts as absent."""
    return header_value or query_value or None


def encode_primer_header(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def decode_primer_header(value: str) -> str | None:
    """None for a value that is not valid base64 of UTF-8 text (ignored, never fatal)."""
    try:
        return base64.b64decode(value, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None


def resolve_primer_context(query_value: str | None, header_value: str | None) -> str | None:
    if header_value:
        decoded = decode_primer_header(header_value)
        if decoded is not None:
            return decoded
    return query_value or None


import re

# A Windows identity (the user ids this deployment stores look like `System.Security.Principal.WindowsIdentity;S-1-5-21-...`)
# and Azure DevOps identity URIs. Messages that reach a job's failure record, its narration or an HTTP error body must not
# carry them: they identify a person, and the SID alone ends up in logs and screenshots.
_IDENTITY_PATTERN = re.compile(
    r"(?:System\.Security\.Principal\.WindowsIdentity;)?S-1-\d+(?:-\d+){2,}|vstfs:///Framework/Identity/[\w-]+",
    re.IGNORECASE,
)


def redact_identity(text: str) -> str:
    """The text with every user identity replaced by `[user]`."""
    return _IDENTITY_PATTERN.sub("[user]", text)
