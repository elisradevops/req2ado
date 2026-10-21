# ingestion/tests/conftest.py
import os

# Must be set before app.main (and anything that imports app.otel) is ever
# imported by a test module -- pytest loads conftest.py first, which is
# exactly what makes that guarantee hold. Without this, every test run
# spends real wall-clock time retrying span export against a real OTLP
# collector that doesn't exist in a test/CI environment (OTEL_SDK_DISABLED
# is OpenTelemetry's own standard env var for this -- the SDK no-ops
# entirely, no code-level branching needed in app.otel itself).
os.environ.setdefault("OTEL_SDK_DISABLED", "true")


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _one_extraction_run_by_default(monkeypatch):
    """The KB profile reads each document EXTRACTION_RUNS times in production. Most tests assert on single calls and single answers, so
    they run with one; tests/test_kb_profile_extraction_runs.py sets it to 3 and tests that behaviour."""
    from app.kb import profile as profile_module

    monkeypatch.setattr(profile_module, "EXTRACTION_RUNS", 1)
