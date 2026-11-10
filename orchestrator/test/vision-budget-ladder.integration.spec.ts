import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';
import { UpstreamHttpError } from '../src/modules/llm/upstream-negotiation';
import { BEHAVIORS, behaviorFromCapabilities, startFakeProxy, type FakeProxy, type ProxyBehavior } from './support/fake-proxy';

// A figure's description must come back complete or fail clearly, on every production model family, never as a
// cut-off reply. The proxy behaviours are the prod families' own (Claude via LiteLLM, GPT-5 reasoning, the gpt-chat alias
// that takes no output limit, gpt-oss with its shared window), each made to "think" or to need more output than the
// first small limit: no Ollama-only parameter may ever be sent.

const ANSWER = '{"significant":true,"description":"A diagram of the flow."}';
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
// The limits the proxy accepted a call with: a call refused for its parameter name (the first one to a model that takes
// max_completion_tokens) is not a limit the model saw.
const limits = (model: string) => hits(model).map((r) => r.body.max_tokens ?? r.body.max_completion_tokens).filter((v, i) => !(i === 0 && hits(model)[1] !== undefined && hits(model)[0].body.max_tokens !== undefined && hits(model)[1].body.max_completion_tokens !== undefined));
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const FORBIDDEN_KEYS = ['options', 'think', 'reasoning_effort', 'seed'];

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await proxy.close();
  jest.restoreAllMocks();
});

const families: [string, ProxyBehavior, string][] = [
  ['claude', BEHAVIORS.claudeOpus, 'max_tokens'],
  ['gpt-5 reasoning', BEHAVIORS.gpt56Reasoning, 'max_completion_tokens'],
  ['gpt-oss', BEHAVIORS.gptOss, 'max_completion_tokens'],
];

describe.each(families)('%s: the output limit is raised step by step and stays valid for the family', (_name, base, param) => {
  it('a model that thinks past 3000 tokens is asked again with 4000, with the family parameter and nothing Ollama-only', async () => {
    proxy = await startFakeProxy({ m: { ...base, reasoningTokens: 3_000, answer: ANSWER } });
    const text = await clientFor('m').vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 120_000 });
    expect(text).toBe(ANSWER);
    expect(limits('m')).toEqual([300, 4_000]);
    // the very first call to a model that takes max_completion_tokens is refused for its parameter name; the accepted ones carry the family's
    expect(param in hits('m')[hits('m').length - 1].body).toBe(true);
    for (const request of hits('m')) for (const key of FORBIDDEN_KEYS) expect(request.body).not.toHaveProperty(key);
  });

  it('a model that thinks past 10000 tokens climbs the ladder to a limit above that, in a bounded number of calls', async () => {
    proxy = await startFakeProxy({ m: { ...base, reasoningTokens: 10_000, answer: ANSWER } });
    const text = await clientFor('m').vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 });
    expect(text).toBe(ANSWER);
    expect(limits('m')).toEqual([300, 4_000, 16_000]);
  });

  it('the raised limit is remembered, so the next figure starts at the known-good limit', async () => {
    proxy = await startFakeProxy({ m: { ...base, reasoningTokens: 3_000, answer: ANSWER } });
    const client = clientFor('m');
    await client.vision('Describe.', [png], { model: 'm' });
    await client.vision('Describe.', [png], { model: 'm' });
    expect(limits('m')).toEqual([300, 4_000, 4_000]);
  });
});

describe('how a stuck vision rung ends', () => {
  it('a rung that times out ends as a 504, not an untyped 500', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, latencyMs: 1_500, answer: ANSWER } });
    const client = clientFor('m');
    (client as unknown as { config: { LLM_REQUEST_TIMEOUT_MS: number } }).config.LLM_REQUEST_TIMEOUT_MS = 600_000;
    (client as unknown as { rungTimeout: () => { timeout: number } }).rungTimeout = () => ({ timeout: 300 });
    const error = await client.vision('Describe.', [png], { model: 'm' }).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect((error as UpstreamHttpError).upstreamStatus).toBe(504);
  });
});

describe('model limits are never exceeded', () => {
  it('a model with a stated output ceiling of 8192 is never asked for more once it has said so, and the end is a clear failure', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, maxOutput: 8_192, reasoningTokens: 20_000, answer: ANSWER } });
    const error = await clientFor('m').vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect((error as UpstreamHttpError).upstreamStatus).toBe(422);
    const sent = limits('m');
    expect(sent[sent.length - 1]).toBeLessThanOrEqual(8_192);
    expect(sent.length).toBeLessThanOrEqual(8);
    expect(sent.filter((v) => v > 8_192)).toEqual([16_000]); // only the one request the proxy refused, which taught the ceiling
    // the learned ceiling holds for the next call on the same client
    const client = clientFor('m');
    await client.vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 }).catch(() => undefined);
    const before = hits('m').length;
    await client.vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 }).catch(() => undefined);
    expect(hits('m').slice(before).every((r) => (r.body.max_tokens ?? 0) <= 8_192)).toBe(true);
  });

  it('a model that states a ceiling above 16000 is still never asked for more than 16000', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, maxOutput: 128_000, reasoningTokens: 100_000, answer: ANSWER } });
    const error = await clientFor('m').vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 }).catch((e) => e);
    expect((error as UpstreamHttpError).upstreamStatus).toBe(422);
    expect(Math.max(...limits('m'))).toBe(16_000);
  });

  it('what a figure needed is not applied to chat calls to the same model', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, reasoningTokens: 3_000, answer: ANSWER } });
    const client = clientFor('m');
    await client.vision('Describe.', [png], { model: 'm' });
    await client.chat([{ role: 'user', content: 'hi' }], { model: 'm', maxTokens: 5_000 }).catch(() => undefined);
    const chat = hits('m').filter((r) => r.body.messages?.[0]?.content === 'hi');
    expect(chat.map((r) => r.body.max_tokens)).toEqual([5_000]);
  });

  it('the gpt-chat alias takes no output limit at all, so there is nothing to raise and none is ever sent after the refusal', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.gptChatLatestProxyConverts, answer: ANSWER } });
    expect(await clientFor('m').vision('Describe.', [png], { model: 'm' })).toBe(ANSWER);
    const last = hits('m')[hits('m').length - 1];
    expect(last.body).not.toHaveProperty('max_tokens');
    expect(last.body).not.toHaveProperty('max_completion_tokens');
    expect(hits('m').length).toBeLessThanOrEqual(4);
  });

  it('an unknown model starts with the default parameter, learns from the refusal, then raises with the learned one', async () => {
    proxy = await startFakeProxy({ 'brand-new-model': { tokenParam: 'max_completion_tokens', temperature: 'any', schema: 'ok', reasoningTokens: 1_000, answer: ANSWER } });
    expect(await clientFor('brand-new-model').vision('Describe.', [png], { model: 'brand-new-model' })).toBe(ANSWER);
    expect(limits('brand-new-model').slice(-2)).toEqual([300, 4_000]);
  });
});

describe('a cut-off reply is never taken for a description', () => {
  it('a reply cut off at the limit is asked again with a larger limit and the complete answer is returned', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, truncatedBelow: 4_000, answer: ANSWER } });
    expect(await clientFor('m').vision('Describe.', [png], { model: 'm' })).toBe(ANSWER);
    expect(limits('m')).toEqual([300, 4_000]);
  });

  it('a reply still cut off at the highest limit the model allows fails with a 422 and returns no text', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, maxOutput: 4_000, truncatedBelow: 1_000_000, answer: ANSWER } });
    const error = await clientFor('m').vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect((error as UpstreamHttpError).upstreamStatus).toBe(422);
    // raised to the ceiling before giving up, not failed at the first cut-off; 16000 is the one request the proxy refused, which taught the ceiling
    expect(limits('m')).toEqual([300, 4_000, 16_000, 4_000]);
  });
});

describe('the deadline stops the ladder cleanly', () => {
  it('when the deadline blocks the raise the call fails with a 504 (transient), not a 500, and the higher limit is remembered', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, reasoningTokens: 1_000, answer: ANSWER } });
    const client = clientFor('m');
    const error = await client.vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 5_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect((error as UpstreamHttpError).upstreamStatus).toBe(504);
    expect(hits('m')).toHaveLength(1);
    expect(await client.vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 120_000 })).toBe(ANSWER);
    expect(limits('m')).toEqual([300, 4_000]);
  });
});

// The prod model names, through the capability table: the first call must already be right (no refused call to learn from),
// and the ladder starts from that seeded state.
describe.each(['claude-opus-4-8', 'claude-sonnet-4-6', 'gpt-5.5', 'gpt-5.6-terra', 'gpt-oss-120b'])('prod model %s, first call from the capability table', (model) => {
  it('sends the right parameters on the very first call and climbs to a complete answer without a single refused call', async () => {
    const base = behaviorFromCapabilities(model)!;
    proxy = await startFakeProxy({ [model]: { ...base, reasoningTokens: 3_000, answer: ANSWER } });
    expect(await clientFor(model).vision('Describe.', [png], { model, deadlineAtMs: Date.now() + 120_000 })).toBe(ANSWER);
    expect(limits(model)).toEqual([300, 4_000]);
    expect(hits(model)).toHaveLength(2); // nothing was refused and retried: the table already knew
    for (const request of hits(model)) {
      for (const key of FORBIDDEN_KEYS) expect(request.body).not.toHaveProperty(key);
      // refused by Claude and GPT-5 via the proxy (the table seeds it as dropped); gpt-oss is not known to refuse it
      if (base.rejectsParams?.includes('frequency_penalty')) expect(request.body).not.toHaveProperty('frequency_penalty');
      // a fixed-temperature family is either sent its one valid value or none at all, never 0
      if (base.temperature === 'fixed-1' && request.body.temperature !== undefined) expect(request.body.temperature).toBe(1);
      expect(base.tokenParam === 'max_completion_tokens' ? 'max_completion_tokens' in request.body : 'max_tokens' in request.body).toBe(true);
    }
  });
});

describe.each(['gpt-chat-latest', 'gpt-5.2-chat'])('prod model %s takes no output limit', (model) => {
  it('never sends one and is never raised', async () => {
    proxy = await startFakeProxy({ [model]: { ...behaviorFromCapabilities(model)!, answer: ANSWER } });
    expect(await clientFor(model).vision('Describe.', [png], { model })).toBe(ANSWER);
    expect(hits(model)).toHaveLength(1);
    expect(hits(model)[0].body).not.toHaveProperty('max_tokens');
    expect(hits(model)[0].body).not.toHaveProperty('max_completion_tokens');
  });
});

describe('what is remembered for later figures', () => {
  it('one outlier figure that climbed to the ceiling does not make later figures start there', async () => {
    proxy = await startFakeProxy({ m: { ...BEHAVIORS.claudeOpus, reasoningTokens: 10_000, answer: ANSWER } });
    const client = clientFor('m');
    await client.vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 });
    await client.vision('Describe.', [png], { model: 'm', deadlineAtMs: Date.now() + 600_000 });
    expect(limits('m')).toEqual([300, 4_000, 16_000, 4_000, 16_000]); // the second figure restarts at the middle rung, not the ceiling
  });
});
