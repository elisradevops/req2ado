import { MODEL_CAPABILITIES, capabilitiesFor, seedConstraints } from '../src/modules/llm/model-capabilities';
import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';
import { portableSchemaViolations } from '../src/modules/llm/portable-schema';
import { behaviorFromCapabilities, startFakeProxy, type FakeProxy } from './support/fake-proxy';

// The request rules per model family (what each family refuses and demands), written from prod evidence and vendor
// documentation. The negotiation loop starts from them so the first attempt is already right; whatever they do not
// cover is still learned from the upstream's answer.

describe('model capability table', () => {
  it.each([
    ['claude-opus-4-8', 'claude-4-and-5'],
    ['claude-sonnet-4-6', 'claude-4-and-5'],
    ['claude-haiku-4-5', 'claude-4-and-5'],
    ['OpenAI/gpt-5.6-terra', 'gpt-5-reasoning'],
    ['OpenAI/gpt-5.5', 'gpt-5-reasoning'],
    ['OpenAI/gpt-chat-latest', 'gpt-chat-latest'],
    ['OpenAI/gpt-5.1-chat', 'gpt-chat-alias'],
    ['OpenAI/gpt-oss-120b', 'gpt-oss'],
  ])('%s belongs to the %s family', (model, family) => {
    expect(capabilitiesFor(model)?.family).toBe(family);
  });

  it('gpt-chat-latest takes only temperature 1 (the proxy refused 0 in prod), and the table seeds it', () => {
    expect(seedConstraints('OpenAI/gpt-chat-latest')?.temperature).toBe(1);
    expect(seedConstraints('OpenAI/gpt-chat-latest')?.omitTokenLimit).toBe(true);
  });

  it('says nothing about a model it does not know (it is learned from the upstream instead)', () => {
    expect(capabilitiesFor('llama3.1')).toBeNull();
    expect(capabilitiesFor('mistral-large')).toBeNull();
    expect(seedConstraints('llama3.1')).toBeUndefined();
  });

  it('every entry names its sources and the date they were checked', () => {
    for (const entry of MODEL_CAPABILITIES) {
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const source of entry.sources) expect(source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('the structured-output rule matches the portable schema rules, and the table has no overlapping families', () => {
    const names = MODEL_CAPABILITIES.map((e) => e.family);
    expect(new Set(names).size).toBe(names.length);
    for (const probe of ['claude-opus-4-8', 'OpenAI/gpt-5.6-terra', 'OpenAI/gpt-chat-latest', 'OpenAI/gpt-oss-120b']) {
      expect(MODEL_CAPABILITIES.filter((e) => new RegExp(e.match, 'i').test(probe))).toHaveLength(1);
    }
    expect(portableSchemaViolations({ type: 'object', properties: {}, required: [], additionalProperties: false })).toEqual([]);
  });

  it('seeds what negotiation would otherwise have to learn by failing', () => {
    expect(seedConstraints('claude-opus-4-8')).toMatchObject({ temperature: 1 });
    expect(seedConstraints('OpenAI/gpt-5.6-terra')).toMatchObject({ temperature: 1, tokenParam: 'max_completion_tokens' });
    expect(seedConstraints('OpenAI/gpt-chat-latest')).toMatchObject({ omitTokenLimit: true });
    expect(seedConstraints('OpenAI/gpt-oss-120b')).toMatchObject({ tokenParam: 'max_completion_tokens' });
  });
});

describe('the client starts from the table: no failed first attempt for a known family', () => {
  let proxy: FakeProxy;
  const clientFor = (model: string) =>
    new OpenWebUiClient({
      LLM_BASE_URL: `${proxy.url}/v1`, LLM_API_KEY: 'k', LLM_CHAT_MODEL: model, LLM_TRUSTED_LOCAL: true, EMBED_TRANSPORT: 'ollama',
      EMBED_MODEL: 'e', EMBED_PATH: '/api/embed', SHOW_PATH: '/api/show', FILES_UPLOAD_PATH: '/f', FILES_STATUS_PATH: '/f',
      LLM_REQUEST_TIMEOUT_MS: 10_000, LLM_SEND_SEED: false, LLM_SEND_REASONING_EFFORT: false,
    } as OpenWebUiClientConfig);

  afterEach(async () => {
    await proxy.close();
  });

  // The fake proxy here is BUILT FROM THE TABLE, so the table and the proxy cannot disagree: if a rule is wrong the
  // first attempt fails and this test says so.
  it.each(['claude-opus-4-8', 'OpenAI/gpt-5.6-terra', 'OpenAI/gpt-chat-latest', 'OpenAI/gpt-oss-120b'])('%s succeeds on the first request', async (model) => {
    const behavior = behaviorFromCapabilities(model);
    expect(behavior).not.toBeNull();
    proxy = await startFakeProxy({ [model]: behavior! });
    const result = await clientFor(model).chat([{ role: 'user', content: 'Reply OK.' }], { model, temperature: 0, maxTokens: 300 });
    expect(result.content).toBe('OK');
    expect(proxy.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(1);
  });
});
