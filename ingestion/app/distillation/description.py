from __future__ import annotations


def assemble_description(existing: str, addition: str) -> str:
    """BASELINE-mode description assembly: joins verbatim text with a
    newline, never mutating or normalizing either input. Str is immutable in
    Python, so 'no mutation' here just means the function is pure — it
    returns a new string, never alters existing/addition in place (which
    plain str concatenation already guarantees, but is worth stating
    explicitly since this mirrors the fidelity guarantees the redaction pass
    (Phase 1) and BASELINE hashing (Phase 4) both depend on)."""
    return existing + "\n" + addition


def strip_leading_title(description: str, title: str) -> str:
    """Drops a title that is repeated as the whole first line of `description`
    when body text follows it (R5). Heading-only text, a blank body, and a
    title that is only the first sentence of a paragraph are returned as is, so
    no text is ever cut mid-statement and a description is never emptied."""
    if not title:
        return description
    prefix = title + "\n"
    if not description.startswith(prefix):
        return description
    body = description[len(prefix):]
    return body if body.strip() else description
