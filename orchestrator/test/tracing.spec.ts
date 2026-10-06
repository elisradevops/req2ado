const getNodeAutoInstrumentations = jest.fn(() => ['auto-instrumentations']);
const nodeSdkCtor = jest.fn();
const start = jest.fn();

jest.mock('@opentelemetry/auto-instrumentations-node', () => ({ getNodeAutoInstrumentations }));
jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(options: unknown) {
      nodeSdkCtor(options);
    }
    start = start;
  },
}));
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));
jest.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: (attrs: unknown) => attrs }));

function loadTracing(): void {
  jest.isolateModules(() => {
    require('../src/tracing');
  });
}

describe('tracing bootstrap', () => {
  const original = process.env.OTEL_SDK_DISABLED;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (original === undefined) delete process.env.OTEL_SDK_DISABLED;
    else process.env.OTEL_SDK_DISABLED = original;
  });

  it('constructs no auto-instrumentations when OTEL_SDK_DISABLED is true -- nothing gets monkey-patched', () => {
    // Regression: a disabled SDK never hands instrumentation-openai a meter
    // provider, so its histograms stay undefined and any failed OpenAI call
    // crashed the process with an unhandled rejection.
    process.env.OTEL_SDK_DISABLED = 'true';

    loadTracing();

    expect(getNodeAutoInstrumentations).not.toHaveBeenCalled();
    expect(nodeSdkCtor).toHaveBeenCalledWith(expect.objectContaining({ instrumentations: [] }));
  });

  it('treats the flag case-insensitively, per the OTel spec', () => {
    process.env.OTEL_SDK_DISABLED = 'TRUE';

    loadTracing();

    expect(getNodeAutoInstrumentations).not.toHaveBeenCalled();
  });

  it('still wires the auto-instrumentations when tracing is enabled', () => {
    delete process.env.OTEL_SDK_DISABLED;

    loadTracing();

    expect(getNodeAutoInstrumentations).toHaveBeenCalledTimes(1);
    expect(nodeSdkCtor).toHaveBeenCalledWith(
      expect.objectContaining({ instrumentations: [['auto-instrumentations']] }),
    );
    expect(start).toHaveBeenCalledTimes(1);
  });
});
