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
