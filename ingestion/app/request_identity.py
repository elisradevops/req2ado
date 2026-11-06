"""Who is calling, and what document overview rides along, without putting either in a URL.

The orchestrator used to send `user_id` and the whole-document overview (`primer_context`, a model-written summary of
the customer's document) as query parameters of `/ingest` and `/level`. The server's access log records the full URL, so
both ended up in the pod log on every job. They travel in headers only (the query form was removed one release after the
orchestrator stopped sending it; an orchestrator older than 0.3.12 no longer works). The overview can contain any language,
so it is base64 of its UTF-8 bytes."""
from __future__ import annotations

import base64
import binascii
import hashlib
import re

USER_ID_HEADER = "X-Req2Ado-User-Id"
PRIMER_HEADER = "X-Req2Ado-Primer-Context"


def resolve_user_id(header_value: str | None) -> str | None:
    """The user of the call, from its header; an empty header counts as absent."""
    return header_value or None


def user_scope(user_id: str | None) -> str:
    """A cache-key part that isolates one user's cached answers from another's. Hashed so the raw id never reaches a key or a
    log line; "anon" for a call without a user. That value is only a placeholder: callers must not use it to share cached or stored state,
    a call without a user id uses no cache and no store at all."""
    if not user_id:
        return "anon"
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16]


def encode_primer_header(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def decode_primer_header(value: str) -> str | None:
    """None for a value that is not valid base64 of UTF-8 text (ignored, never fatal)."""
    try:
        return base64.b64decode(value, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None


def resolve_primer_context(header_value: str | None) -> str | None:
    """The document overview, decoded from its header; None when absent or not valid base64 of UTF-8."""
    return decode_primer_header(header_value) if header_value else None



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
