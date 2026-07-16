import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

describe('OpenWebUiClient', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
    // EMBED_TRANSPORT deliberately left as 'openai' (the intentionally-unimplemented branch) so this
    // shared fixture keeps compiling against the Task 2 config shape without altering the behavior
    // of the pre-existing "embed() throws not-implemented" test below.
    EMBED_TRANSPORT: 'openai' as const,
    EMBED_BASE_URL: undefined,
    EMBED_MODEL: 'nomic-embed-text',
    EMBED_PATH: '/api/embed',
  };

  it('redacts messages before sending, by default', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'contact jane@example.com' }]);

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'contact <redacted>' }],
        model: 'llama3.1',
      }),
    );
  });

  it('does NOT redact when LLM_TRUSTED_LOCAL is true', async () => {
    const trustedClient = new OpenWebUiClient({ ...config, LLM_TRUSTED_LOCAL: true });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    trustedClient.openai.chat.completions.create = fakeCreate;

    await trustedClient.chat([{ role: 'user', content: 'contact jane@example.com' }]);

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'contact jane@example.com' }] }),
    );
  });

  it('returns the response content string', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'The answer is 42.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('The answer is 42.');
  });

  it('passes temperature through when provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it('embed() throws not-implemented in this phase', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/not implemented/i);
  });

  it('vision() throws not-implemented in this phase', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.vision('prompt', [])).rejects.toThrow(/not implemented/i);
  });

  it('lists available models from the OpenAI-compatible /v1/models endpoint', async () => {
    const client = new OpenWebUiClient(config);
    const fakeList = jest.fn().mockResolvedValue({ data: [{ id: 'llama3.1' }, { id: 'qwen2.5:14b' }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.models.list = fakeList;

    const models = await client.listModels();

    expect(models).toEqual(['llama3.1', 'qwen2.5:14b']);
  });

  it('passes an explicit model through when provided, overriding LLM_CHAT_MODEL', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { model: 'qwen2.5:14b' });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen2.5:14b' }));
  });

  it('streamChat yields text deltas from a streamed completion', async () => {
    const client = new OpenWebUiClient(config);
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'Hel' } }] };
      yield { choices: [{ delta: { content: 'lo' } }] };
      yield { choices: [{ delta: {} }] }; // no content — must be skipped, not yielded as ''
    }
    const fakeCreate = jest.fn().mockResolvedValue(fakeStream());
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const deltas: string[] = [];
    for await (const delta of client.streamChat([{ role: 'user', content: 'hi' }], { model: 'llama3.1' })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.1', stream: true }));
  });
});

describe('OpenWebUiClient.embed (ollama transport)', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_BASE_URL: undefined,
    EMBED_MODEL: 'nomic-embed-text',
    EMBED_PATH: '/api/embed',
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('calls the Ollama-shaped /api/embed endpoint with {model, input}', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });

    const client = new OpenWebUiClient(config);
    await client.embed(['The unit shall survive a drop.']);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', input: ['The unit shall survive a drop.'] }),
      }),
    );
  });

  it('falls back to LLM_BASE_URL host when EMBED_BASE_URL is unset, stripping /v1', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient(config);
    await client.embed(['text']);
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:11434/api/embed');
  });

  it('uses EMBED_BASE_URL directly when set, overriding the LLM_BASE_URL fallback', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient({ ...config, EMBED_BASE_URL: 'http://embed-host:9000' });
    await client.embed(['text']);
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toBe('http://embed-host:9000/api/embed');
  });

  it('returns the embeddings array from the response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }),
    });
    const client = new OpenWebUiClient(config);
    const result = await client.embed(['a', 'b']);
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it('throws on a non-ok response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/embed.*500/i);
  });

  it('throws not-implemented for EMBED_TRANSPORT=openai', async () => {
    const client = new OpenWebUiClient({ ...config, EMBED_TRANSPORT: 'openai' as const });
    await expect(client.embed(['text'])).rejects.toThrow(/not implemented/i);
  });

  it('uses EMBED_PATH when set to the Open WebUI proxy path, instead of /api/embed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient({ ...config, EMBED_PATH: '/ollama/api/embed' });
    await client.embed(['text']);
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:11434/ollama/api/embed');
  });
});
