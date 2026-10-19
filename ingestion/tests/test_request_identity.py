import base64
import json
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.canonical.model import Block, BlockKind, CanonicalDoc, Document, DocumentFormat, SourceRef
from app.main import app
from app.request_identity import decode_primer_header, encode_primer_header, resolve_primer_context, resolve_user_id

client = TestClient(app)


def test_the_header_wins_over_the_query_and_either_alone_works() -> None:
    assert resolve_user_id("from-query", "from-header") == "from-header"
    assert resolve_user_id("from-query", None) == "from-query"
    assert resolve_user_id(None, "from-header") == "from-header"
    assert resolve_user_id(None, None) is None
    assert resolve_user_id("q", "") == "q"  # an empty header is no header


def test_the_primer_header_carries_any_unicode_text_losslessly() -> None:
    text = "מסמך דרישות -- spec with ünïcode and a newline\nand 100% of it"
    header = encode_primer_header(text)
    assert header.isascii() and "\n" not in header
    assert decode_primer_header(header) == text
    assert resolve_primer_context("query text", header) == text
    assert resolve_primer_context("query text", None) == "query text"
    assert resolve_primer_context(None, None) is None


def test_a_malformed_primer_header_is_ignored_not_fatal() -> None:
    assert decode_primer_header("%%% not base64 %%%") is None
    assert resolve_primer_context("query text", "%%% not base64 %%%") == "query text"


def _doc() -> CanonicalDoc:
    ref = SourceRef(document_path="x.txt", start_offset=0, end_offset=10)
    return CanonicalDoc(
        document=Document(path="x.txt", format=DocumentFormat.TXT, sha256="h"),
        blocks=[Block(id="b0", kind=BlockKind.PARAGRAPH, text="1 Receiver", source_ref=ref)],
    )


def test_level_reads_identity_and_primer_from_headers_so_they_never_ride_in_the_url() -> None:
    captured: dict = {}

    def fake_build(*args, **kwargs):
        captured.update(kwargs)
        from app.workitem.model import WorkItemTree

        return WorkItemTree(nodes=[], warnings=[])

    primer = "A short document overview."
    with patch("app.main._build_survey_tree_with_scoring", side_effect=lambda *a, **k: fake_build(*a, **k)) as mocked:
        response = client.post(
            "/level?mode=survey&job_id=j1",
            content=_doc().model_dump_json(),
            headers={
                "Content-Type": "application/json",
                "X-Req2Ado-User-Id": "user-from-header",
                "X-Req2Ado-Primer-Context": encode_primer_header(primer),
            },
        )
    assert response.status_code == 200, response.text
    seen = {**{f"arg{i}": a for i, a in enumerate(mocked.call_args.args)}, **mocked.call_args.kwargs}
    assert "user-from-header" in seen.values()
    assert primer in seen.values()
    assert "user-from-header" not in str(response.request.url) and "overview" not in str(response.request.url)


def test_level_still_accepts_the_old_query_form_for_one_release() -> None:
    from app.workitem.model import WorkItemTree

    with patch("app.main._build_survey_tree_with_scoring", return_value=WorkItemTree(nodes=[], warnings=[])) as mocked:
        response = client.post(
            "/level?mode=survey&user_id=old-user&primer_context=old+primer",
            content=_doc().model_dump_json(),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 200, response.text
    seen = {**{f"arg{i}": a for i, a in enumerate(mocked.call_args.args)}, **mocked.call_args.kwargs}
    assert "old-user" in seen.values() and "old primer" in seen.values()


def test_describe_exception_never_carries_a_user_identity() -> None:
    from app.http_errors import describe_exception
    from app.request_identity import redact_identity

    sid = "System.Security.Principal.WindowsIdentity;S-1-5-21-30753869-2048262725-1213672966-812815"
    assert describe_exception(KeyError(sid)) == "'[user]'"
    assert "S-1-5-21" not in redact_identity(f"failed for {sid} and again S-1-5-21-1-2-3-4")
    assert redact_identity("vstfs:///Framework/Identity/abc-123 failed") == "[user] failed"
    assert redact_identity("a normal message about the Receiver") == "a normal message about the Receiver"
    assert redact_identity("") == ""
