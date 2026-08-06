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
