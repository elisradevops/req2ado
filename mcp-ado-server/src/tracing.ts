// mcp-ado-server/src/tracing.ts
//
// OpenTelemetry bootstrap (S6) -- must be the FIRST import in index.ts,
// before express/http are themselves imported, per Node OTel's
// monkey-patch-on-require instrumentation model. Same convention as
// orchestrator/src/tracing.ts and ingestion/app/otel.py -- see either for
// the fuller rationale (auto-instruments http+express here; undici matters
// less in this service today but costs nothing to include, and matters
// once this service's own outbound ADO calls are worth tracing too).
//
// Exports via OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (unset = the
// exporter's own default, http://localhost:4318/v1/traces) -- a no-op
// locally with nothing listening, same as the other two services.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'req2ado-mcp-ado-server';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

export { sdk as otelSdk };
