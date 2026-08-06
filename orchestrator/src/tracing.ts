// orchestrator/src/tracing.ts
//
// OpenTelemetry bootstrap (S6) -- must be the FIRST import in every
// entrypoint (main.ts, pipeline-worker.main.ts), before any instrumented
// module (http, express, undici/fetch) is itself imported, per Node OTel's
// own patching model (auto-instrumentation monkey-patches a module's
// exports at require() time; importing the target module first means the
// patch never applies).
//
// Covers http + express + undici via getNodeAutoInstrumentations() --
// undici specifically matters once mcp.client.ts moves off the MCP SDK
// onto plain fetch (S9): every ADO call becomes traceable for free the
// moment that lands, with zero further instrumentation work.
//
// Exports via OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (unset = the
// exporter's own default, http://localhost:4318/v1/traces) -- same
// "always wired, a no-op locally with nothing listening, point it
// somewhere real in prod" convention ingestion's app/otel.py already
// follows.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'req2ado-orchestrator';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

export { sdk as otelSdk };
