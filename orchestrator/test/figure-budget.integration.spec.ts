import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';
import { startFakeProxy, type FakeProxy, type ProxyBehavior } from './support/fake-proxy';

// A figure's vision call must stay inside its budget and must stop when the caller goes away: against a fake proxy that is
// slow, that thinks away a small output limit, and that notices a closed connection.

let proxy: FakeProxy;
const thinking: ProxyBehavior = { tokenParam: 'max_tokens', temperature: 'any', schema: 'ok', reasoningTokens: 1_000, answer: '{"significant":true,"description":"A diagram."}' };

const clientFor = (model: string): OpenWebUiClient =>
  new OpenWebUiClient({
    LLM_BASE_URL: `${proxy.url}/v1`,
    LLM_API_KEY: 'test-key',
    LLM_CHAT_MODEL: model,
    LLM_TRUSTED_LOCAL: true,
    EMBED_TRANSPORT: 'ollama',
    EMBED_MODEL: 'e',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 10_000,
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  } as OpenWebUiClientConfig);
const hits = (model: string) => proxy.requests.filter((r) => r.path === '/v1/chat/completions' && r.body.model === model);
const png = Buffer.from('89504e470d0a1a0a', 'hex');

afterEach(async () => {
  await proxy.close();
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('vision call budget', () => {
  it('an empty answer at the output limit is retried with a larger budget while there is time left', async () => {
    proxy = await startFakeProxy({ 'think-1': thinking });
    const text = await clientFor('think-1').vision('Describe.', [png], { model: 'think-1', deadlineAtMs: Date.now() + 120_000 });
    expect(text).toContain('A diagram.');
    expect(hits('think-1').map((r) => r.body.max_tokens)).toEqual([300, 4000]);
  });

  it('no new attempt is started once the deadline is too close, so the call ends instead of queueing another slow attempt', async () => {
    proxy = await startFakeProxy({ 'think-1': thinking });
    await expect(
      clientFor('think-1').vision('Describe.', [png], { model: 'think-1', deadlineAtMs: Date.now() + 5_000 }),
    ).rejects.toBeDefined();
    expect(hits('think-1')).toHaveLength(1);
  });
});

describe('vision call log line', () => {
  it('logs one line per call with attempts, time, finish reason and sizes, never the text', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    proxy = await startFakeProxy({ 'think-1': thinking });
    await clientFor('think-1').vision('Describe.', [png], { model: 'think-1' });
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[OpenWebUiClient.vision]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/model=think-1/);
    expect(lines[0]).toMatch(/attempts=2/); // 300 tokens came back empty, then the larger budget answered
    expect(lines[0]).toMatch(/finishReason=stop/);
    expect(lines[0]).toMatch(/completionTokens=\d+/);
    expect(lines[0]).toMatch(/chars=\d+/);
    expect(lines[0]).toMatch(/elapsedMs=\d+/);
    expect(lines[0]).not.toContain('A diagram.');
  });
});

describe('vision call abort', () => {
  it('an aborted call stops at once and the proxy sees the connection close', async () => {
    proxy = await startFakeProxy({ 'slow-1': { ...thinking, reasoningTokens: undefined, latencyMs: 3_000 } });
    const controller = new AbortController();
    const started = Date.now();
    const call = clientFor('slow-1').vision('Describe.', [png], { model: 'slow-1', signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(call).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_500);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(proxy.aborted).toEqual(['slow-1']);
    expect(hits('slow-1')).toHaveLength(1); // an abort is never retried
  });

  it('a call already aborted never reaches the proxy', async () => {
    proxy = await startFakeProxy({ 'slow-1': { ...thinking, reasoningTokens: undefined } });
    const controller = new AbortController();
    controller.abort();
    await expect(clientFor('slow-1').vision('Describe.', [png], { model: 'slow-1', signal: controller.signal })).rejects.toBeDefined();
    expect(hits('slow-1')).toHaveLength(0);
  });
});
