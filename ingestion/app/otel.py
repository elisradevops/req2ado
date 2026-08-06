# ingestion/app/otel.py
"""OpenTelemetry setup for ingestion (S6) -- this service had zero tracing
before this, despite being where 100% of the pipeline's LLM cost/latency
actually happens. Auto-instruments FastAPI (every route) and httpx (every
call to the orchestrator's /llm/* proxy and every ADO-adjacent HTTP call) so
a job's whole request path is traceable for free. Manual spans additionally
wrap the two highest-volume LLM call sites (analyze_section,
score_requirements_for_document in app.survey.orchestrator_llm_client) with
gen_ai.* attributes (OTel's GenAI semantic conventions) the generic HTTP
span can't see, since model/response-shape data lives inside the request/
response body, not the transport layer.

Exports via OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (unset = the SDK's own
default, http://localhost:4318/v1/traces) -- same "always wired, point it
somewhere real in prod, a no-op export failure locally never fails the
job" convention every other optional integration in this codebase already
follows (BatchSpanProcessor drops/retries in the background; it does not
raise into request-handling code on an unreachable collector).
"""
from __future__ import annotations

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_SERVICE_NAME = "req2ado-ingestion"

_tracer_provider: TracerProvider | None = None


def setup_otel(app: FastAPI) -> None:
    """Called once from main.py at import time, before the app starts
    serving. Idempotent-guarded (module-level _tracer_provider) so tests
    that import main.py multiple times in one process don't double-register
    a global tracer provider (OpenTelemetry logs a warning and ignores the
    second registration either way, but this keeps instrumentation calls
    from double-wrapping FastAPI/httpx too)."""
    global _tracer_provider
    if _tracer_provider is not None:
        return
    _tracer_provider = TracerProvider(resource=Resource.create({"service.name": _SERVICE_NAME}))
    _tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(_tracer_provider)
    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()


def get_tracer() -> trace.Tracer:
    return trace.get_tracer(_SERVICE_NAME)
