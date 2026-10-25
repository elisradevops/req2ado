"""Test helper: the caller's identity travels in headers, never in the URL (see app.request_identity)."""
from app.request_identity import PRIMER_HEADER, USER_ID_HEADER, encode_primer_header


def identity_headers(params: dict) -> dict:
    """Moves `user_id` and `primer_context` out of `params` into the headers that carry them; an empty value sends no header."""
    headers: dict = {}
    if user_id := params.pop("user_id", None):
        headers[USER_ID_HEADER] = user_id
    if primer := params.pop("primer_context", None):
        headers[PRIMER_HEADER] = encode_primer_header(primer)
    return headers
