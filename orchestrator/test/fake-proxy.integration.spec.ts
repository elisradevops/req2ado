import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';
import { BEHAVIORS, startFakeProxy, type FakeProxy } from './support/fake-proxy';

// The real client against a real HTTP server that behaves like the proxy in front of each model family. No fetch mocks:
// the SDK, the headers, the negotiation loop and the remembered adaptations all run as in production.

const MODELS = {
  'claude-opus-4-8': BEHAVIORS.claudeOpus,
  'claude-sonnet-4-6': BEHAVIORS.claudeSonnetSchemaFlaky,
  'OpenAI/gpt-5.6-terra': BEHAVIORS.gpt56Reasoning,
  'OpenAI/gpt-chat-latest': BEHAVIORS.gptChatLatestProxyConverts,
  'OpenAI/gpt-oss-120b': BEHAVIORS.gptOss,
};

let proxy: FakeProxy;
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
const user = [{ role: 'user' as const, content: 'Reply OK.' }];

beforeEach(async () => {
  proxy = await startFakeProxy(MODELS);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await proxy.close();
  jest.restoreAllMocks();
});

describe('OpenWebUiClient against the fake proxy', () => {
  it('Claude (temperature fixed at 1): the table makes the very first call go out at 1', async () => {
    const client = clientFor('claude-opus-4-8');
    expect((await client.chat(user, { model: 'claude-opus-4-8', temperature: 0, maxTokens: 100 })).content).toBe('OK');
    expect(hits('claude-opus-4-8').map((r) => r.body.temperature)).toEqual([1]);
  });

  it('a model the table does not know is learned from the refusal: retried at 1, and the next call starts at 1', async () => {
    await proxy.close();
    proxy = await startFakeProxy({ 'mystery-model-1': BEHAVIORS.claudeOpus });
    const client = clientFor('mystery-model-1');
    await client.chat(user, { model: 'mystery-model-1', temperature: 0, maxTokens: 100 });
    expect(hits('mystery-model-1').map((r) => r.body.temperature)).toEqual([0, 1]);
    await client.chat(user, { model: 'mystery-model-1', temperature: 0, maxTokens: 100 });
    expect(hits('mystery-model-1').map((r) => r.body.temperature)).toEqual([0, 1, 1]);
  });

  it('GPT-5.x reasoning: max_tokens is switched to max_completion_tokens and temperature 0 to 1 in one call, both remembered', async () => {
    const client = clientFor('OpenAI/gpt-5.6-terra');
    await client.chat(user, { model: 'OpenAI/gpt-5.6-terra', temperature: 0, maxTokens: 300 });
    const sent = hits('OpenAI/gpt-5.6-terra').map((r) => ({ t: r.body.temperature, mt: r.body.max_tokens, mct: r.body.max_completion_tokens }));
    expect(sent[sent.length - 1]).toEqual({ t: 1, mt: undefined, mct: 300 });
    const before = hits('OpenAI/gpt-5.6-terra').length;
    await client.chat(user, { model: 'OpenAI/gpt-5.6-terra', temperature: 0, maxTokens: 300 });
    expect(hits('OpenAI/gpt-5.6-terra').length - before).toBe(1); // already learned: no failed first attempt
  });

  it('a proxy that turns max_completion_tokens back into max_tokens: the call goes out with no output limit', async () => {
    const client = clientFor('OpenAI/gpt-chat-latest');
    expect((await client.chat(user, { model: 'OpenAI/gpt-chat-latest', maxTokens: 500 })).content).toBe('OK');
    const last = hits('OpenAI/gpt-chat-latest').pop()!;
    expect('max_tokens' in last.body || 'max_completion_tokens' in last.body).toBe(false);
  });

  it('gpt-oss: 200000 output tokens is clamped to what fits beside the input (context window counts the output)', async () => {
    const client = clientFor('OpenAI/gpt-oss-120b');
    expect((await client.chat(user, { model: 'OpenAI/gpt-oss-120b', maxTokens: 200_000 })).content).toBe('OK');
    const sent = hits('OpenAI/gpt-oss-120b').map((r) => r.body.max_completion_tokens ?? r.body.max_tokens);
    const final = sent[sent.length - 1];
    expect(final).toBeLessThan(131_072);
    expect(final).toBeGreaterThan(130_000);
  });

  it('a schema refused with an empty 400 is retried without the schema and the answer still arrives', async () => {
    const client = clientFor('claude-sonnet-4-6');
    const schema = { name: 's', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }, strict: true };
    expect((await client.chat(user, { model: 'claude-sonnet-4-6', responseSchema: schema, maxTokens: 100 })).content).toBe('OK');
    const sent = hits('claude-sonnet-4-6');
    expect(sent[0].body.response_format?.type).toBe('json_schema');
    expect(sent[sent.length - 1].body.response_format).toBeUndefined();
  });

  it('the model listing reads a fake Open WebUI /api/models the way the real one answers', async () => {
    const models = await clientFor('claude-opus-4-8').listSelectableModels();
    expect(models.map((m) => m.id).sort()).toEqual(Object.keys(MODELS).sort());
  });
});

describe('rate limits', () => {
  const limited = () => startFakeProxy({ 'claude-opus-4-8': { ...BEHAVIORS.claudeOpus, rateLimitedCalls: { count: 1, retryAfterSeconds: 0 } } });

  it('a 429 is repeated after the provider\'s Retry-After and then succeeds', async () => {
    await proxy.close();
    proxy = await limited();
    expect((await clientFor('claude-opus-4-8').chat(user, { model: 'claude-opus-4-8', maxTokens: 100 })).content).toBe('OK');
    expect(proxy.requests).toHaveLength(2);
  });

  it('gives up after the bounded number of repeats and reports the 429', async () => {
    await proxy.close();
    proxy = await startFakeProxy({ 'claude-opus-4-8': { ...BEHAVIORS.claudeOpus, rateLimitedCalls: { count: 99, retryAfterSeconds: 0 } } });
    await expect(clientFor('claude-opus-4-8').chat(user, { model: 'claude-opus-4-8', maxTokens: 100 })).rejects.toMatchObject({ upstreamStatus: 429 });
    expect(proxy.requests).toHaveLength(3); // the first call and two repeats
  });
});
