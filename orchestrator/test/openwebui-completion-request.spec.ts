import { readFileSync } from 'fs';
import { join } from 'path';
import { APP_REQUEST_KEYS, openWebUiCompletionRequestSchema } from '../src/modules/llm/openwebui-api';
import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';
import { BEHAVIORS, startFakeProxy, type FakeProxy } from './support/fake-proxy';

// Contract of the request body of `/api/chat/completions`: the web client's captured requests must be accepted, and every
// request this app actually sends (recorded by the fake proxy) must conform to the same schema and use only fields the app
// is meant to send.

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'openwebui', name), 'utf8'));
const schema = { name: 'answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };

describe('request schema', () => {
  it.each(['chat-request.claude-opus-4-8.json', 'chat-request.gpt-oss-120b.json'])('accepts the captured web client request %s', (file) => {
    expect(openWebUiCompletionRequestSchema.safeParse(fixture(file)).success).toBe(true);
  });

  it('refuses an unknown field, a bad role, an empty model and a malformed response_format', () => {
    const ok = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    expect(openWebUiCompletionRequestSchema.safeParse(ok).success).toBe(true);
    expect(openWebUiCompletionRequestSchema.safeParse({ ...ok, max_token: 5 }).success).toBe(false);
    expect(openWebUiCompletionRequestSchema.safeParse({ ...ok, messages: [{ role: 'robot', content: 'x' }] }).success).toBe(false);
    expect(openWebUiCompletionRequestSchema.safeParse({ ...ok, model: '' }).success).toBe(false);
    expect(openWebUiCompletionRequestSchema.safeParse({ ...ok, response_format: { type: 'json_schema' } }).success).toBe(false);
  });
});

describe('requests the app sends', () => {
  let proxy: FakeProxy;
  const clientFor = (model: string) =>
    new OpenWebUiClient({
      LLM_BASE_URL: `${proxy.url}/v1`, LLM_API_KEY: 'k', LLM_CHAT_MODEL: model, LLM_TRUSTED_LOCAL: true, EMBED_TRANSPORT: 'ollama',
      EMBED_MODEL: 'e', EMBED_PATH: '/api/embed', SHOW_PATH: '/api/show', FILES_UPLOAD_PATH: '/api/v1/files/', FILES_STATUS_PATH: '/api/v1/files',
      LLM_REQUEST_TIMEOUT_MS: 10_000, LLM_SEND_SEED: true, LLM_SEND_REASONING_EFFORT: true,
    } as OpenWebUiClientConfig);
  const completions = () => proxy.requests.filter((r) => r.path === '/v1/chat/completions' || r.path === '/api/chat/completions');

  beforeEach(async () => {
    proxy = await startFakeProxy({ 'claude-opus-4-8': BEHAVIORS.claudeOpus, 'OpenAI/gpt-5.6-terra': BEHAVIORS.gpt56Reasoning, 'OpenAI/gpt-oss-120b': BEHAVIORS.gptOss });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await proxy.close();
    jest.restoreAllMocks();
  });

  it.each(['claude-opus-4-8', 'OpenAI/gpt-5.6-terra', 'OpenAI/gpt-oss-120b'])('chat, structured chat and vision bodies for %s conform and use only app fields', async (model) => {
    const client = clientFor(model);
    const user = [{ role: 'user' as const, content: 'Reply OK.' }];
    await client.chat(user, { model, temperature: 0, seed: 7, maxTokens: 100 });
    await client.chat(user, { model, maxTokens: 100, responseSchema: schema as never });
    await client.vision('What colour?', [Buffer.from('png')], { model, mimeType: 'image/png' }).catch(() => undefined);
    await client.chatWithFullFileContext('Name the colour.', 'file-1', { model, maxTokens: 100 }).catch(() => undefined);
    const sent = completions().filter((r) => r.body.model === model);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    for (const request of sent) {
      expect(openWebUiCompletionRequestSchema.safeParse(request.body)).toMatchObject({ success: true });
      expect(Object.keys(request.body).filter((key) => !(APP_REQUEST_KEYS as readonly string[]).includes(key))).toEqual([]);
    }
  });

  it('the file-context call names its file the way the route expects', async () => {
    await clientFor('claude-opus-4-8').chatWithFullFileContext('Name the colour.', 'file-1', { model: 'claude-opus-4-8', maxTokens: 100 });
    const primer = proxy.requests.find((r) => r.path === '/api/chat/completions');
    expect(primer?.body.files).toEqual([{ type: 'file', id: 'file-1', context: 'full' }]);
  });
});
