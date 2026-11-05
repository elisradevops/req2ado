import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prod-llm-probe.py"


def _load():
    spec = importlib.util.spec_from_file_location("prod_llm_probe", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Stub(BaseHTTPRequestHandler):
    """A proxy that takes max_completion_tokens only, refuses reasoning_effort, thinks 400 tokens before answering, and rate-limits the 3rd+ parallel call."""

    seen: list[dict] = []
    calls = 0

    def log_message(self, *args):  # quiet
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, {"data": [{"id": "stub-model", "info": {"meta": {"max_output_tokens": 8192, "context_length": 128000}}}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).seen.append(body)
        if "max_tokens" in body:
            return self._send(400, {"error": {"message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}})
        if "reasoning_effort" in body:
            return self._send(400, {"error": {"message": "litellm.UnsupportedParamsError: reasoning_effort"}})
        limit = body.get("max_completion_tokens")
        text = "".join(str(m.get("content", "")) for m in body["messages"] if isinstance(m.get("content"), str))
        prompt_tokens = max(1, len(text) // 3)
        if isinstance(limit, int) and limit <= 400:
            return self._send(200, {"choices": [{"message": {"content": ""}, "finish_reason": "length"}], "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": limit, "completion_tokens_details": {"reasoning_tokens": limit}}})
        return self._send(200, {"choices": [{"message": {"content": '{"significant": true, "description": "A diagram."}'}, "finish_reason": "stop"}], "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 40, "completion_tokens_details": {"reasoning_tokens": 0}}})


def _serve():
    _Stub.seen = []
    server = HTTPServer(("127.0.0.1", 0), _Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_the_probe_learns_the_output_limit_parameter_and_the_reasoning_cost_and_never_prints_the_key(capsys) -> None:
    probe = _load()
    server, base = _serve()
    try:
        report = probe.run(base, "SECRET-KEY-123", ["stub-model"], image_path=None, parallel=(1, 2))
    finally:
        server.shutdown()
    model = report["models"]["stub-model"]
    assert model["listing"] == {"max_output_tokens": 8192, "context_length": 128000}
    assert model["token_param"] == "max_completion_tokens"
    assert model["reasoning_effort_accepted"] is False
    assert model["small_limit"]["finish_reason"] == "length" and model["small_limit"]["reasoning_tokens"] == 400
    assert model["hebrew"]["chars_per_token"] is not None
    assert set(model["parallel"]) == {"1", "2"}
    assert "SECRET-KEY-123" not in json.dumps(report)
    assert "SECRET-KEY-123" not in capsys.readouterr().out


def test_an_image_is_sent_only_when_one_is_given_and_its_verdict_is_reported(tmp_path) -> None:
    probe = _load()
    image = tmp_path / "figure.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    server, base = _serve()
    try:
        without = probe.run(base, "k", ["stub-model"], image_path=None, parallel=(1,))
        with_image = probe.run(base, "k", ["stub-model"], image_path=str(image), parallel=(1,))
    finally:
        server.shutdown()
    assert "vision" not in without["models"]["stub-model"]
    vision = with_image["models"]["stub-model"]["vision"]
    assert vision["significant"] is True and vision["finish_reason"] == "stop"
    sent_images = [b for b in _Stub.seen if any(isinstance(m.get("content"), list) for m in b["messages"])]
    assert sent_images and "data:image/png;base64," in json.dumps(sent_images[0])


def test_the_command_line_prints_a_readable_summary_writes_the_report_and_needs_its_settings(monkeypatch, capsys, tmp_path) -> None:
    probe = _load()
    server, base = _serve()
    out = tmp_path / "probe.json"
    try:
        monkeypatch.delenv("PROBE_BASE_URL", raising=False)
        monkeypatch.setattr("sys.argv", ["prod-llm-probe.py", "--models", "stub-model"])
        assert probe.main() == 2  # no settings: says so, probes nothing
        monkeypatch.setenv("PROBE_BASE_URL", base)
        monkeypatch.setenv("PROBE_API_KEY", "SECRET-KEY-123")
        monkeypatch.setattr("sys.argv", ["prod-llm-probe.py", "--models", "stub-model", "--parallel", "1", "--json-out", str(out)])
        assert probe.main() == 0
    finally:
        server.shutdown()
    printed = capsys.readouterr().out
    assert "== stub-model" in printed and "output-limit parameter: max_completion_tokens" in printed and "reasoning_effort accepted: False" in printed
    assert "SECRET-KEY-123" not in printed and "SECRET-KEY-123" not in out.read_text()
    assert json.loads(out.read_text())["models"]["stub-model"]["token_param"] == "max_completion_tokens"
