import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  modelFactsFromEntry,
  openWebUiChatRequestSchema,
  openWebUiModelEntrySchema,
} from '../src/modules/llm/openwebui-model-entry';
import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

// Real shapes captured from the proxy's Open WebUI (redacted): one model entry per supported family and the chat
// request its web client sends. They are the mocks for everything that reads a model listing.
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'openwebui', name), 'utf8'));
const ENTRIES = {
  'claude-opus-4-8': 'model-entry.claude-opus-4-8.json',
  'claude-sonnet-4-6': 'model-entry.claude-sonnet-4-6.json',
  'OpenAI/gpt-5.6-terra': 'model-entry.OpenAI_gpt-5.6-terra.json',
  'OpenAI/gpt-chat-latest': 'model-entry.OpenAI_gpt-chat-latest.json',
  'OpenAI/gpt-oss-120b': 'model-entry.OpenAI_gpt-oss-120b.json',
} as const;

describe('Open WebUI model entry schema', () => {
  it.each(Object.entries(ENTRIES))('parses the real entry of %s', (id, file) => {
    const parsed = openWebUiModelEntrySchema.parse(fixture(file));
    expect(parsed.id).toBe(id);
  });

  it('rejects an entry with no id and keeps unknown fields (the proxy adds fields over time)', () => {
    expect(openWebUiModelEntrySchema.safeParse({ name: 'x' }).success).toBe(false);
    const parsed = openWebUiModelEntrySchema.parse({ id: 'm', some_new_field: 1 });
    expect((parsed as Record<string, unknown>).some_new_field).toBe(1);
  });

  it.each(['chat-request.claude-opus-4-8.json', 'chat-request.gpt-oss-120b.json'])('parses the web client request %s', (file) => {
    const parsed = openWebUiChatRequestSchema.parse(fixture(file));
    expect(parsed.stream).toBe(true);
    expect(parsed.params).toEqual({});
    expect(parsed.model_item.id).toBe(parsed.model);
  });
});

describe('what the app takes from a model entry', () => {
  const facts = (id: keyof typeof ENTRIES) => modelFactsFromEntry(openWebUiModelEntrySchema.parse(fixture(ENTRIES[id])));

  it('reads the context and output limits the entry states (Claude), and says nothing when it does not (GPT, gpt-oss)', () => {
    expect(facts('claude-opus-4-8')).toMatchObject({ contextTokens: 1_000_000, maxOutputTokens: 128_000 });
    expect(facts('claude-sonnet-4-6')).toMatchObject({ contextTokens: 1_000_000, maxOutputTokens: 64_000 });
    for (const id of ['OpenAI/gpt-5.6-terra', 'OpenAI/gpt-chat-latest', 'OpenAI/gpt-oss-120b'] as const) {
      expect(facts(id)).toMatchObject({ contextTokens: null, maxOutputTokens: null });
    }
  });

  it('does not believe the vision flag Open WebUI sets on every model: gpt-oss-120b has no vision', () => {
    // all five entries say capabilities.vision = true; the compatibility probe showed gpt-oss-120b rejects images
    expect(facts('OpenAI/gpt-oss-120b').vision).toBe(false);
    expect(facts('claude-opus-4-8').vision).toBe(true);
    expect(facts('OpenAI/gpt-5.6-terra').vision).toBe(true);
  });

  it('prefers a vision signal the connection itself reports (Ollama) over the flag', () => {
    const ollamaNoVision = openWebUiModelEntrySchema.parse({ id: 'gemma4:e4b', ollama: { capabilities: ['completion'] }, info: { meta: { capabilities: { vision: true } } } });
    expect(modelFactsFromEntry(ollamaNoVision).vision).toBe(false);
    const ollamaVision = openWebUiModelEntrySchema.parse({ id: 'qwen3.6:35b', ollama: { capabilities: ['vision'] } });
    expect(modelFactsFromEntry(ollamaVision).vision).toBe(true);
  });

  it('ignores limits that are not positive numbers', () => {
    const bad = openWebUiModelEntrySchema.parse({ id: 'm', max_input_tokens: 0, max_output_tokens: 'lots' });
    expect(modelFactsFromEntry(bad)).toMatchObject({ contextTokens: null, maxOutputTokens: null });
  });

  it('reads a limit from the nested connection object when the top level has none', () => {
    const nested = openWebUiModelEntrySchema.parse({ id: 'm', openai: { id: 'm', max_input_tokens: 200_000, max_output_tokens: 8_192 } });
    expect(modelFactsFromEntry(nested)).toMatchObject({ contextTokens: 200_000, maxOutputTokens: 8_192 });
  });
});

describe('OpenWebUiClient.showModel falls back to the model listing', () => {
  const config = {
    LLM_BASE_URL: 'https://proxy.example/api/v1',
    LLM_API_KEY: 'k',
    LLM_CHAT_MODEL: 'claude-opus-4-8',
    LLM_TRUSTED_LOCAL: false,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_MODEL: 'e',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 5000,
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  };
  const listing = { data: Object.values(ENTRIES).map((file) => fixture(file)) };

  // The deployment has no Ollama /api/show and no LiteLLM /model/info (both answer 404 or the web page); only
  // /api/models answers.
  const routed = (url: string): Promise<unknown> => {
    if (url.endsWith('/api/models')) return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => listing });
    if (url.endsWith('/api/show')) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, headers: { get: () => 'text/html' }, json: async () => ({}) });
  };

  beforeEach(() => {
    global.fetch = jest.fn(routed as never);
  });

  it('returns the limits of a Claude entry', async () => {
    const info = await new OpenWebUiClient(config).showModel('claude-opus-4-8');
    expect(info).toMatchObject({ contextLength: 1_000_000, maxOutputTokens: 128_000, source: 'litellm' });
  });

  it('matches the id case-insensitively and does not invent limits for an entry that states none', async () => {
    const client = new OpenWebUiClient(config);
    expect(await client.showModel('CLAUDE-SONNET-4-6')).toMatchObject({ contextLength: 1_000_000, maxOutputTokens: 64_000 });
    await expect(client.showModel('OpenAI/gpt-5.6-terra')).resolves.toMatchObject({ contextLength: null, capabilities: [] });
  });

  it('a model missing from the listing is unavailable, not an error of the call', async () => {
    await expect(new OpenWebUiClient(config).showModel('nope')).rejects.toThrow(/No model information available/);
  });
});
