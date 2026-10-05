import httpx

from app.http_errors import describe_exception, exception_details


def _status_error(status: int, body: dict) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://orchestrator:3001/llm/chat")
    response = httpx.Response(status, json=body, request=request)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        return exc
    raise AssertionError("expected an error status")


def test_describe_http_status_error_uses_detail_and_drops_mdn_link() -> None:
    text = describe_exception(_status_error(502, {"detail": "model not found"}))
    assert text == "POST http://orchestrator:3001/llm/chat returned 502: model not found"


def test_describe_plain_exception_is_str() -> None:
    assert describe_exception(ValueError("boom")) == "boom"


def test_exception_details_includes_traceback_only_when_enabled() -> None:
    exc = _status_error(500, {"detail": "x"})
    assert "traceback" not in exception_details(exc, include_traceback=False)
    details = exception_details(exc, include_traceback=True)
    assert details["status"] == 500
    assert details["method"] == "POST"
    assert "HTTPStatusError" in details["traceback"]
