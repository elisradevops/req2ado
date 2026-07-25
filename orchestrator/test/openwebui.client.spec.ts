import OpenAI from 'openai';
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
    expect(result.content).toBe('The answer is 42.');
  });

  it('passes temperature through when provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it('forwards maxTokens as max_tokens when provided (bounds worst-case latency)', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { maxTokens: 8000 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 8000 }));
  });

  it('omits max_tokens when maxTokens is not provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(fakeCreate.mock.calls[0][0]).not.toHaveProperty('max_tokens');
  });

  it('forwards numCtx as options.num_ctx when provided (Ollama-specific passthrough)', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { numCtx: 28000 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ options: { num_ctx: 28000 } }));
  });

  it('omits options.num_ctx when numCtx is not provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(fakeCreate.mock.calls[0][0]).not.toHaveProperty('options');
  });

  it('forwards topK/minP as options.top_k/options.min_p when provided (Gemma4 repetition-collapse mitigation)', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { topK: 50, minP: 0.05 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ options: { top_k: 50, min_p: 0.05 } }));
  });

  it('omits options.top_k/options.min_p when not provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(fakeCreate.mock.calls[0][0]).not.toHaveProperty('options');
  });

  it('merges numCtx and topK/minP into ONE options object instead of the second overwriting the first', async () => {
    // Regression guard: a naive `...(numCtx ? {options: {...}} : {}), ...(topK ? {options: {...}} : {})`
    // spread pattern would have the second `options:` key silently OVERWRITE
    // the first in the object literal, losing num_ctx entirely whenever both
    // are set together -- exactly the case every real SURVEY call now hits.
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { numCtx: 28000, topK: 50, minP: 0.05 });
    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ options: { num_ctx: 28000, top_k: 50, min_p: 0.05 } }),
    );
  });

  it('forwards responseSchema as response_format: json_schema when provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: '[]' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], {
      responseSchema: { name: 'hierarchy', schema: { type: 'array' } },
    });

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_schema', json_schema: { name: 'hierarchy', schema: { type: 'array' } } },
      }),
    );
  });

  it('omits response_format entirely when no responseSchema is provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: '[]' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }]);

    expect(fakeCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  it('degrades to a schema-less retry when the backend rejects response_format with a 400', async () => {
    const client = new OpenWebUiClient(config);
    const rejection = new OpenAI.APIError(400, { message: 'bad param' }, 'bad param', {} as any);
    const fakeCreate = jest
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ choices: [{ message: { content: '[]' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }], {
      responseSchema: { name: 'hierarchy', schema: { type: 'array' } },
    });

    expect(result.content).toBe('[]');
    expect(fakeCreate).toHaveBeenCalledTimes(2);
    expect(fakeCreate.mock.calls[0][0]).toHaveProperty('response_format');
    expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('response_format');
  });

  it('does not retry on a non-schema-rejection error even when a responseSchema was provided', async () => {
    const client = new OpenWebUiClient(config);
    const rejection = new OpenAI.APIError(500, { message: 'server error' }, 'server error', {} as any);
    const fakeCreate = jest.fn().mockRejectedValue(rejection);
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await expect(
      client.chat([{ role: 'user', content: 'hi' }], { responseSchema: { name: 'hierarchy', schema: {} } }),
    ).rejects.toThrow();
    expect(fakeCreate).toHaveBeenCalledTimes(1);
  });

  it('forwards tools as-is and omits tool_choice when not provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const tools = [{ type: 'function' as const, function: { name: 'query_kb', parameters: { type: 'object' } } }];
    await client.chat([{ role: 'user', content: 'hi' }], { tools });

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ tools }));
    expect(fakeCreate.mock.calls[0][0]).not.toHaveProperty('tool_choice');
  });

  it('forwards toolChoice as tool_choice when provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], {
      tools: [{ type: 'function', function: { name: 'query_kb', parameters: {} } }],
      toolChoice: 'auto',
    });

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ tool_choice: 'auto' }));
  });

  it('surfaces toolCalls and finishReason from the response alongside content', async () => {
    const client = new OpenWebUiClient(config);
    const toolCalls = [{ id: 'call_1', type: 'function' as const, function: { name: 'query_kb', arguments: '{"query":"power rail"}' } }];
    const fakeCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
    });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }], {
      tools: [{ type: 'function', function: { name: 'query_kb', parameters: {} } }],
    });

    expect(result).toEqual({ content: '', toolCalls, finishReason: 'tool_calls' });
  });

  it('returns empty toolCalls/finishReason fields when the model does not call a tool', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'plain answer' }, finish_reason: 'stop' }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(result).toEqual({ content: 'plain answer', toolCalls: undefined, finishReason: 'stop' });
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

  it('embed() throws not-implemented in this phase', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/not implemented/i);
  });

  it('vision() throws when no model is configured and no override is passed', async () => {
    const client = new OpenWebUiClient(config); // config has no LLM_VISION_MODEL
    await expect(client.vision('prompt', [Buffer.from('img')])).rejects.toThrow(/no model/i);
  });

  it('vision() sends a multimodal content array to the same chat.completions endpoint', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'A block diagram.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.vision('describe this figure', [Buffer.from('fake-png-bytes')]);

    expect(result).toBe('A block diagram.');
    expect(fakeCreate).toHaveBeenCalledWith({
      model: 'llava',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this figure' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}` } },
          ],
        },
      ],
    });
  });

  it('vision() redacts the prompt text (not the image) unless LLM_TRUSTED_LOCAL is true', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('contact jane@example.com about this figure', [Buffer.from('img')]);

    const sentContent = fakeCreate.mock.calls[0][0].messages[0].content;
    expect(sentContent[0].text).toBe('contact <redacted> about this figure');
  });

  it('vision() uses opts.model over the configured LLM_VISION_MODEL when both are present', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('img')], { model: 'moondream' });

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'moondream' }));
  });

  it('vision() uses opts.mimeType in the data URI when supplied (a real non-PNG image)', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('fake-jpeg-bytes')], { mimeType: 'image/jpeg' });

    const sentContent = fakeCreate.mock.calls[0][0].messages[0].content;
    expect(sentContent[1].image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`);
  });

  it('vision() defaults to image/png in the data URI when opts.mimeType is not supplied', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('img')]);

    const sentContent = fakeCreate.mock.calls[0][0].messages[0].content;
    expect(sentContent[1].image_url.url).toMatch(/^data:image\/png;base64,/);
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
