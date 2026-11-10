import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';
import { UpstreamHttpError } from '../src/modules/llm/upstream-negotiation';
import { BEHAVIORS, behaviorFromCapabilities, startFakeProxy, type FakeProxy, type ProxyBehavior } from './support/fake-proxy';

// A document-study window (structured JSON, 3000 output tokens asked) must survive a thinking model on every production family
// without leaking its raised limit to other chat calls, without ever asking for more than the study ceiling, and without sending
// an Ollama-only parameter. Default chat keeps its single raise.

const ANSWER = '{"glossary":[],"placeholder_tokens":[]}';
let proxy: FakeProxy;
const clientFor = (model: string): OpenWebUiClient =>
  new OpenWebUiClient({
    LLM_BASE_URL: `${proxy.url}/v1`, LLM_API_KEY: 'test-key', LLM_CHAT_MODEL: model, LLM_TRUSTED_LOCAL: false, EMBED_TRANSPORT: 'ollama', EMBED_MODEL: 'e',
    EMBED_PATH: '/api/embed', SHOW_PATH: '/api/show', FILES_UPLOAD_PATH: '/api/v1/files/', FILES_STATUS_PATH: '/api/v1/files', LLM_REQUEST_TIMEOUT_MS: 10_000,
    LLM_SEND_SEED: false, LLM_SEND_REASONING_EFFORT: false,
  } as OpenWebUiClientConfig);
const hits = (model: string) => proxy.requests.filter((r) => r.path === '/v1/chat/completions' && r.body.model === model);
const sent = (model: string) => hits(model).map((r) => r.body.max_tokens ?? r.body.max_completion_tokens);
const FORBIDDEN = ['options', 'think', 'reasoning_effort', 'seed', 'frequency_penalty'];
const study = (maxTokens = 3000, extra: Record<string, unknown> = {}) => ({ maxTokens, budgetKind: 'study' as const, ...extra });
const msg = [{ role: 'user' as const, content: 'window text' }];

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await proxy.close();
  jest.restoreAllMocks();
});

describe.each([
  ['claude-opus-4-8', 'max_tokens'],
  ['gpt-5.5', 'max_completion_tokens'],
  ['gpt-oss-120b', 'max_completion_tokens'],
])('study call on prod model %s', (model, param) => {
  it('goes 3000 -> 12000 (one raise) with the family parameter and nothing Ollama-only, and the probe-sized call before it leaves no floor behind', async () => {
    proxy = await startFakeProxy({ [model]: { ...behaviorFromCapabilities(model)!, reasoningTokens: 5_000, answer: ANSWER } });
    const client = clientFor(model);
    await client.chat(msg, { model, maxTokens: 200 }); // a health probe: raises once (to 4000) and is still empty
    const before = hits(model).length;
    const result = await client.chat(msg, { model, ...study() });
    expect(result.content).toBe(ANSWER);
    expect(sent(model).slice(before)).toEqual([3_000, 12_000]);
    for (const request of hits(model)) {
      for (const key of FORBIDDEN) expect(request.body).not.toHaveProperty(key);
    }
    expect(param in hits(model)[hits(model).length - 1].body).toBe(true);
  });

  it('is raised once, never above 12000, and ends with the empty answer, not an exception, when even that is not enough', async () => {
    proxy = await startFakeProxy({ [model]: { ...behaviorFromCapabilities(model)!, reasoningTokens: 30_000, answer: ANSWER } });
    const result = await clientFor(model).chat(msg, { model, ...study() });
    expect(result.content).toBe('');
    expect(result.finishReason).toBe('length');
    expect(sent(model)).toEqual([3_000, 12_000]); // one raise, no ladder
    expect(Math.max(...sent(model))).toBe(12_000);
  });
});

describe('study call details', () => {
  it('a model that takes no output limit is sent none and called once', async () => {
    proxy = await startFakeProxy({ 'gpt-chat-latest': { ...behaviorFromCapabilities('gpt-chat-latest')!, answer: ANSWER } });
    await clientFor('gpt-chat-latest').chat(msg, { model: 'gpt-chat-latest', ...study() });
    expect(hits('gpt-chat-latest')).toHaveLength(1);
    expect(sent('gpt-chat-latest')).toEqual([undefined]);
  });

  it('a limit learned by one study call is where the next one starts, and a default chat call does not inherit it', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, reasoningTokens: 5_000, answer: ANSWER } });
    const client = clientFor('m');
    await client.chat(msg, { model: 'm', ...study() });
    await client.chat(msg, { model: 'm', ...study() });
    await client.chat(msg, { model: 'm', maxTokens: 50 });
    expect(sent('m')).toEqual([3_000, 12_000, 12_000, 50, 4_000]); // the default call still gets its own single raise, from its own 50
  });

  it('default chat keeps exactly one raise', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, reasoningTokens: 30_000, answer: ANSWER } });
    await clientFor('m').chat(msg, { model: 'm', maxTokens: 3_000 });
    expect(sent('m')).toEqual([3_000, 12_000]);
  });

  it('a deadline that leaves no time for the raise ends the call with a 504 and remembers the higher limit', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, reasoningTokens: 5_000, answer: ANSWER } });
    const client = clientFor('m');
    const error = await client.chat(msg, { model: 'm', ...study(3_000, { deadlineAtMs: Date.now() + 5_000 }) }).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect((error as UpstreamHttpError).upstreamStatus).toBe(504);
    expect(hits('m')).toHaveLength(1);
    await client.chat(msg, { model: 'm', ...study() });
    expect(sent('m')[1]).toBe(12_000);
  });

  it('every study rung is sent with a timeout inside the proxy cut, default chat with none of its own', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, answer: ANSWER } });
    const client = clientFor('m');
    (client as unknown as { config: { LLM_REQUEST_TIMEOUT_MS: number } }).config.LLM_REQUEST_TIMEOUT_MS = 600_000; // longer than the proxy's cut
    const create = jest.spyOn((client as unknown as { openai: { chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } } } }).openai.chat.completions, 'create');
    await client.chat(msg, { model: 'm', ...study() });
    await client.chat(msg, { model: 'm', maxTokens: 50 });
    expect((create.mock.calls[0][1] as { timeout: number }).timeout).toBe(280_000);
    expect(create.mock.calls[1][1]).toBeUndefined();
  });

  it('a partial answer cut off at the limit is raised too, and the complete answer is returned', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, truncatedBelow: 10_000, answer: ANSWER } });
    const result = await clientFor('m').chat(msg, { model: 'm', ...study() });
    expect(result.content).toBe(ANSWER);
    expect(sent('m')).toEqual([3_000, 12_000]);
  });

  it('a partial answer still cut off at the ceiling is returned as it is, with finishReason length, for the caller to split', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, truncatedBelow: 50_000, answer: ANSWER } });
    const result = await clientFor('m').chat(msg, { model: 'm', ...study() });
    expect(result.finishReason).toBe('length');
    expect(result.content).not.toBe(ANSWER);
    expect(sent('m')).toEqual([3_000, 12_000]);
  });

  it('a whitespace-only answer at the limit counts as empty and is raised', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, reasoningTokens: 5_000, answer: ANSWER, emptyContent: ' \n' } });
    expect((await clientFor('m').chat(msg, { model: 'm', ...study() })).content).toBe(ANSWER);
    expect(sent('m')).toEqual([3_000, 12_000]);
  });

  it('a rung that times out ends as a 504, not an untyped 500', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, latencyMs: 1_500, answer: ANSWER } });
    const client = clientFor('m');
    (client as unknown as { config: { LLM_REQUEST_TIMEOUT_MS: number } }).config.LLM_REQUEST_TIMEOUT_MS = 600_000;
    (client as unknown as { rungTimeout: () => { timeout: number } }).rungTimeout = () => ({ timeout: 300 });
    const error = await client.chat(msg, { model: 'm', ...study() }).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect((error as UpstreamHttpError).upstreamStatus).toBe(504);
  });

  it('a request timeout at or under the rung cut is left alone, and default chat sends no budget fields', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, answer: ANSWER } });
    const client = clientFor('m'); // 10 s
    const create = jest.spyOn((client as unknown as { openai: { chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } } } }).openai.chat.completions, 'create');
    await client.chat(msg, { model: 'm', ...study() });
    expect(create.mock.calls[0][1]).toBeUndefined();
    expect(hits('m')[0].body).not.toHaveProperty('budgetKind');
    expect(hits('m')[0].body).not.toHaveProperty('deadlineMs');
  });
});

describe('what counts as real work on a backend, and cancelling a call', () => {
  it('counts a call while it runs, but not a background probe, and a cancelled call stops at the proxy', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, latencyMs: 400, answer: ANSWER } });
    const client = clientFor('m');
    expect(client.activeWorkCalls()).toBe(0);
    const real = client.chat(msg, { model: 'm', maxTokens: 100 });
    const probe = client.chat(msg, { model: 'm', maxTokens: 100, background: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.activeWorkCalls()).toBe(1);
    await Promise.all([real, probe]);
    expect(client.activeWorkCalls()).toBe(0);

    const controller = new AbortController();
    const cancelled = client.chat(msg, { model: 'm', maxTokens: 100, signal: controller.signal }).catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(proxy.aborted).toContain('m');
    expect(client.activeWorkCalls()).toBe(0);
  });
});
