import OpenAI from 'openai';
import { OpenWebUiClient, type OpenWebUiClientConfig } from '../src/modules/llm/openwebui.client';

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
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 600_000,
  };

  it('constructs the OpenAI client with an explicit timeout and maxRetries: 0 (never blindly retries a non-idempotent, multi-minute inference call)', () => {
    // Regression: the SDK's own default (maxRetries: 2) previously re-ran a
    // whole >10min inference up to 3 times on timeout before ever surfacing
    // an error -- the real root cause of job a830aa30's ~66min failure.
    const client = new OpenWebUiClient({ ...config, LLM_REQUEST_TIMEOUT_MS: 123456 });
    expect((client as any).openai.maxRetries).toBe(0);
    expect((client as any).openai.timeout).toBe(123456);
  });

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

  it('forwards think: false as reasoning_effort: none (Ollama-specific, not the OpenAI-typed low/medium/high)', async () => {
    // Confirmed live against Ollama's OpenAI-compat endpoint: a bare
    // `think`/`options.think` field is silently ignored (a real `reasoning`
    // field still appears in the response, no speedup) -- reasoning_effort
    // is the field Ollama's own openai.go actually maps to its internal
    // think toggle, confirmed via Ollama's source (ReasoningEffort ->
    // api.ThinkValue), and 'none' is an Ollama-specific extension beyond
    // real OpenAI's low/medium/high/null.
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { think: false });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: 'none' }));
  });

  it('omits reasoning_effort when think is true or not provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { think: true });
    expect(fakeCreate.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');

    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('reasoning_effort');
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

  it('forwards files as-is when provided (Open WebUI-native whole-document primer reference, Phase 6c)', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { files: [{ type: 'file', id: 'file-1' }] });

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ files: [{ type: 'file', id: 'file-1' }] }));
  });

  it('omits files when not provided', async () => {
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(fakeCreate.mock.calls[0][0]).not.toHaveProperty('files');
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

  it('checkHealth reports reachable with a real latency when the backend responds', async () => {
    const client = new OpenWebUiClient(config);
    const fakeList = jest.fn().mockResolvedValue({ data: [] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.models.list = fakeList;

    const result = await client.checkHealth();

    expect(result.status).toBe('reachable');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // A short, explicit per-call timeout -- unlike every other call in this
    // client, which relies on the SDK's own much longer default -- so an
    // unreachable backend fails fast instead of leaving the UI's status dot
    // spinning for minutes.
    expect(fakeList).toHaveBeenCalledWith({ timeout: 5000 });
  });

  it('checkHealth reports unreachable, not a thrown error, when the backend call fails', async () => {
    const client = new OpenWebUiClient(config);
    const fakeList = jest.fn().mockRejectedValue(new Error('connection refused'));
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.models.list = fakeList;

    const result = await client.checkHealth();

    expect(result.status).toBe('unreachable');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
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
      yield { choices: [{ delta: {} }] }; // no content/reasoning — must be skipped, not yielded empty
    }
    const fakeCreate = jest.fn().mockResolvedValue(fakeStream());
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const chunks: { content?: string; reasoning?: string }[] = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { model: 'llama3.1' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ content: 'Hel' }, { content: 'lo' }]);
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.1', stream: true }));
  });

  it('streamChat yields a reasoning model\'s chain-of-thought on a separate field from content', async () => {
    const client = new OpenWebUiClient(config);
    async function* fakeStream() {
      yield { choices: [{ delta: { reasoning: 'Hmm, ' } }] };
      yield { choices: [{ delta: { reasoning: 'let me think.' } }] };
      yield { choices: [{ delta: { content: 'Sure.' } }] };
    }
    const fakeCreate = jest.fn().mockResolvedValue(fakeStream());
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const chunks: { content?: string; reasoning?: string }[] = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { model: 'llama3.1' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ reasoning: 'Hmm, ' }, { reasoning: 'let me think.' }, { content: 'Sure.' }]);
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
      temperature: 0,
      seed: 0,
      max_tokens: 200,
      reasoning_effort: 'none',
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

  it('vision() sends temperature 0 and a fixed seed -- a caption is structured extraction, not creative writing, and feeds branch-splitting downstream', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('img')]);

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0, seed: 0 }));
  });

  it('vision() caps output length -- previously unbounded, unlike every other call in this class', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('img')]);

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 200 }));
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

  it('vision() unconditionally disables reasoning -- a thinking-capable model must not burn max_tokens on chain-of-thought before any caption content', async () => {
    // Real, 100%-reproducible bug this guards against (confirmed live):
    // gemma4:e4b (a real deployed vision model reporting a "thinking"
    // capability) consumed its entire max_tokens budget on internal
    // reasoning tokens, leaving message.content genuinely empty for every
    // single figure in a real document -- "no useful caption returned"
    // for figures that unambiguously have real technical content.
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'gemma4:e4b' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'A wiring diagram.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('img')]);

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: 'none' }));
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
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 600_000,
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

  it('sends an Authorization bearer header when LLM_API_KEY is set -- real Open WebUI 401s without one, unlike raw Ollama', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient({ ...config, LLM_API_KEY: 'sk-real-key' });
    await client.embed(['text']);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-real-key' }) }),
    );
  });

  it('omits the Authorization header entirely when LLM_API_KEY is unset', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient({ ...config, LLM_API_KEY: undefined });
    await client.embed(['text']);
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
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

  it('throws on a non-ok, non-retryable response', async () => {
    // 400 is not in fetchWithRetry's retryable set -- fails fast, isolating
    // this assertion from the retry-then-give-up behavior tested below.
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400 });
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/embed.*400/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503 before giving up, then throws with the final status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503, headers: { get: () => null } });
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/embed.*503/i);
    expect(global.fetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries (embed()'s maxRetries:3)
  }, 10000);

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

describe('OpenWebUiClient.showModel', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_BASE_URL: undefined,
    EMBED_MODEL: 'nomic-embed-text',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 600_000,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('calls the native Ollama /api/show endpoint with {model}, stripping /v1 same as embed()', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 32768 } }),
    });

    const client = new OpenWebUiClient(config);
    await client.showModel('qwen3.6:35b');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/show',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'qwen3.6:35b' }) }),
    );
  });

  it('uses SHOW_PATH when set to the Open WebUI proxy path -- a bare /api/show 405s on real Open WebUI', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ capabilities: [] }) });
    const client = new OpenWebUiClient({ ...config, SHOW_PATH: '/ollama/api/show' });
    await client.showModel('qwen3.6:35b');
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:11434/ollama/api/show');
  });

  it('sends an Authorization bearer header when LLM_API_KEY is set', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ capabilities: [] }) });
    const client = new OpenWebUiClient({ ...config, LLM_API_KEY: 'sk-real-key' });
    await client.showModel('qwen3.6:35b');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-real-key' }) }),
    );
  });

  it('reads context length from the architecture-prefixed model_info key', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ capabilities: ['completion', 'tools', 'vision'], model_info: { 'general.architecture': 'gemma3', 'gemma3.context_length': 131072 } }),
    });
    const client = new OpenWebUiClient(config);
    const result = await client.showModel('gemma4:12b');
    expect(result).toEqual({ contextLength: 131072, capabilities: ['completion', 'tools', 'vision'] });
  });

  it('returns contextLength: null when model_info is missing entirely -- never throws on an absent field', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ capabilities: ['completion'] }) });
    const client = new OpenWebUiClient(config);
    const result = await client.showModel('unknown-model');
    expect(result).toEqual({ contextLength: null, capabilities: ['completion'] });
  });

  it('returns contextLength: null when the architecture key exists but the context_length key for it does not', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ capabilities: [], model_info: { 'general.architecture': 'mystery-arch' } }),
    });
    const client = new OpenWebUiClient(config);
    const result = await client.showModel('mystery-model');
    expect(result.contextLength).toBeNull();
  });

  it('throws on a non-ok response -- lets the caller (ingestion) fall back to its static default', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
    const client = new OpenWebUiClient(config);
    await expect(client.showModel('nonexistent')).rejects.toThrow(/show.*404/i);
  });

  it('throws a clear, specific error for "Arena Model" instead of an opaque HTTP failure -- no /api/show entry exists for an Open WebUI virtual construct', async () => {
    const client = new OpenWebUiClient(config);
    await expect(client.showModel('Arena Model')).rejects.toThrow(/virtual multi-model construct/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('OpenWebUiClient.uploadFile', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:3000/v1',
    LLM_API_KEY: 'test-key',
    LLM_CHAT_MODEL: 'test-model',
    LLM_TRUSTED_LOCAL: true,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_MODEL: 'test-embed',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 5000,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uploads a file and returns its id', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ id: 'file-123' }) });
    const client = new OpenWebUiClient(config);
    const id = await client.uploadFile(Buffer.from('pdf bytes'), 'doc.pdf');
    expect(id).toBe('file-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/files/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the upload response is not ok', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new OpenWebUiClient(config);
    await expect(client.uploadFile(Buffer.from('x'), 'x.pdf')).rejects.toThrow();
  });
});

describe('OpenWebUiClient.pollFileProcessed', () => {
  const config: OpenWebUiClientConfig = {
    LLM_BASE_URL: 'http://localhost:3000/v1',
    LLM_API_KEY: 'test-key',
    LLM_CHAT_MODEL: 'test-model',
    LLM_TRUSTED_LOCAL: true,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_MODEL: 'test-embed',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 5000,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('returns true once status is completed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ status: 'completed' }) });
    const client = new OpenWebUiClient(config);
    const result = await client.pollFileProcessed('file-123', 5000);
    expect(result).toBe(true);
  });

  it('returns false when status is failed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ status: 'failed' }) });
    const client = new OpenWebUiClient(config);
    const result = await client.pollFileProcessed('file-123', 5000);
    expect(result).toBe(false);
  });

  it('returns false on timeout rather than throwing', async () => {
    // Fake timers -- pollFileProcessed's poll loop sleeps (clamped to the
    // remaining budget) between attempts; without this, the test would pay
    // a real ~100ms+ wall-clock wait, and that cost grows every time this
    // pattern gets reused (e.g. Task 12's own tests calling this method).
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ status: 'pending' }) });
    const client = new OpenWebUiClient(config);
    const resultPromise = client.pollFileProcessed('file-123', 100);
    // advanceTimersByTimeAsync (not the sync advanceTimersByTime) -- this
    // loop interleaves a real awaited fetch()/json() microtask chain with
    // the setTimeout sleep on every iteration, and only the async variant
    // correctly flushes those microtasks between fake-timer advances.
    await jest.advanceTimersByTimeAsync(200);
    const result = await resultPromise;
    expect(result).toBe(false);
    jest.useRealTimers();
  });
});

describe('OpenWebUiClient.deleteFile', () => {
  const config: OpenWebUiClientConfig = {
    LLM_BASE_URL: 'http://localhost:3000/v1',
    LLM_API_KEY: 'test-key',
    LLM_CHAT_MODEL: 'test-model',
    LLM_TRUSTED_LOCAL: true,
    EMBED_TRANSPORT: 'ollama' as const,
    EMBED_MODEL: 'test-embed',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 5000,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('does not throw when the delete request fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network error'));
    const client = new OpenWebUiClient(config);
    await expect(client.deleteFile('file-123')).resolves.not.toThrow();
  });
});
