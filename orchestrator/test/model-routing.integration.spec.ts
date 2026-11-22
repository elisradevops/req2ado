import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';
import { BEHAVIORS, startFakeProxy, type FakeProxy, type ProxyBehavior } from './support/fake-proxy';

// The gateway's `Auto` (production finding F7): a complexity router, not a model. Each request is classified again and sent to a model the
// caller never names; the body's `model` stays `Auto`, and the routed model is named only in response headers. What one routed model
// refuses must be learned under that model, never under `Auto`, so another model behind the same name is not sent its adaptation. Model
// names the capability table does not know, so nothing is seeded and only what is learned shows.

const GPT = 'mystery-gpt';
const CLAUDE = 'mystery-claude';
const router = (routingHeaders: ProxyBehavior['routingHeaders']): Record<string, ProxyBehavior> => ({
  [GPT]: BEHAVIORS.gpt56Reasoning,
  [CLAUDE]: BEHAVIORS.claudeOpus,
  Auto: {
    tokenParam: 'max_tokens',
    temperature: 'any',
    schema: 'ok',
    routes: [
      { model: GPT, tier: 'MEDIUM' },
      { model: CLAUDE, tier: 'COMPLEX' },
    ],
    routingHeaders,
  },
});

let proxy: FakeProxy;
const client = (): OpenWebUiClient =>
  new OpenWebUiClient({
    LLM_BASE_URL: `${proxy.url}/v1`,
    LLM_API_KEY: 'test-key',
    LLM_CHAT_MODEL: 'Auto',
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
const temperatures = (model: string) =>
  proxy.requests.filter((r) => r.path.endsWith('/chat/completions') && r.body.model === model).map((r) => r.body.temperature);
const user = [{ role: 'user' as const, content: 'Reply OK.' }];

afterEach(async () => {
  await proxy.close();
  jest.restoreAllMocks();
});
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('a router (Auto) that names the routed model in every answer', () => {
  beforeEach(async () => {
    proxy = await startFakeProxy(router('always'));
  });

  it('each answer says which model the router sent it to, and its tier', async () => {
    const llm = client();
    expect((await llm.chat(user, { model: 'Auto' })).routing).toEqual({ model: GPT, tier: 'MEDIUM' });
    expect((await llm.chat(user, { model: 'Auto' })).routing).toEqual({ model: CLAUDE, tier: 'COMPLEX' });
  });

  it("what a routed model refuses is learned under that model, so the next Auto call is not sent another model's adaptation", async () => {
    const llm = client();
    // The router sends attempt 1 to the GPT model, which refuses temperature 0; attempt 2 (at 1) goes to Claude.
    expect((await llm.chat(user, { model: 'Auto', temperature: 0 })).routing?.model).toBe(CLAUDE);
    expect(temperatures('Auto')).toEqual([0, 1]);
    // The next Auto call starts at 0 again (Auto learned nothing); routed to the GPT model again, it costs one more refusal.
    await llm.chat(user, { model: 'Auto', temperature: 0 });
    expect(temperatures('Auto')).toEqual([0, 1, 0, 1]);
    // A job that names the GPT model itself starts from what the router's answer taught.
    await llm.chat(user, { model: GPT, temperature: 0 });
    expect(temperatures(GPT)).toEqual([1]);
  });

  it('the file-context route says which model answered', async () => {
    expect((await client().chat(user, { model: 'Auto', fileId: 'file-1' })).routing).toEqual({ model: GPT, tier: 'MEDIUM' });
  });
});

describe('a router whose non-streaming answers name no model (what the production baseline saw)', () => {
  beforeEach(async () => {
    proxy = await startFakeProxy(router('streaming-only'));
  });

  it('an answer without the headers names no routed model', async () => {
    expect((await client().chat(user, { model: 'Auto' })).routing).toBeUndefined();
  });

  it('Auto is then its own unknown model: what its answers teach is learned under Auto', async () => {
    const llm = client();
    await llm.chat(user, { model: 'Auto', temperature: 0 });
    expect(temperatures('Auto')).toEqual([0, 1]);
    await llm.chat(user, { model: 'Auto', temperature: 0 });
    expect(temperatures('Auto')).toEqual([0, 1, 1]);
  });

  it('a stream names the routed model on its last chunk', async () => {
    const chunks = [];
    for await (const chunk of client().streamChat(user, { model: 'Auto' })) chunks.push(chunk);
    expect(chunks[chunks.length - 1]).toEqual({ finishReason: 'stop', routing: { model: GPT, tier: 'MEDIUM' } });
  });
});
