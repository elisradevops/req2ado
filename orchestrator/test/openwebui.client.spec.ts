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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
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

  it('forwards seed when provided, and omits it otherwise (pinned sampling is opt-in per call)', async () => {
    // Backs the primer call's temperature/seed pinning (pipeline.worker.ts):
    // without this passthrough, `seed: 0` on a chat() call would be silently
    // dropped and the primer would keep re-sampling.
    // LLM_SEND_SEED: true -- this test verifies the seed IS forwarded when the
    // feature flag is on; separate tests cover the default-false (Azure) path.
    const client = new OpenWebUiClient({ ...config, LLM_SEND_SEED: true });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.chat([{ role: 'user', content: 'hi' }], { seed: 0 });
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ seed: 0 }));

    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('seed');
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
    const client = new OpenWebUiClient({ ...config, LLM_TRUSTED_LOCAL: true });
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
    const client = new OpenWebUiClient({ ...config, LLM_TRUSTED_LOCAL: true });
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
    const client = new OpenWebUiClient({ ...config, LLM_TRUSTED_LOCAL: true });
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
    // LLM_SEND_REASONING_EFFORT: true -- this test verifies the param IS
    // forwarded when enabled; the default-false (Azure) path has its own test.
    const client = new OpenWebUiClient({ ...config, LLM_SEND_REASONING_EFFORT: true });
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

  it('chat() retries without the rejected params when upstream returns a LiteLLM UnsupportedParamsError 400', async () => {
    // LLM_SEND_SEED: true so seed IS sent on the first attempt and the retry strips it.
    const client = new OpenWebUiClient({ ...config, LLM_SEND_SEED: true });
    const rejection = new OpenAI.APIError(
      400,
      { message: "azure does not support parameters: ['seed']" },
      "azure does not support parameters: ['seed']",
      {} as any,
    );
    const fakeCreate = jest
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'ok without seed' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }], { seed: 42 });

    expect(result.content).toBe('ok without seed');
    expect(fakeCreate).toHaveBeenCalledTimes(2);
    expect(fakeCreate.mock.calls[0][0]).toHaveProperty('seed', 42);
    expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('seed');
  });

  it('streamChat() retries without the rejected params when upstream returns a LiteLLM UnsupportedParamsError 400', async () => {
    // LLM_SEND_SEED: true so seed IS sent on the first attempt and the retry strips it.
    const client = new OpenWebUiClient({ ...config, LLM_SEND_SEED: true });
    const rejection = new OpenAI.APIError(
      400,
      { message: "azure does not support parameters: ['seed']" },
      "azure does not support parameters: ['seed']",
      {} as any,
    );
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'ok without seed' } }] };
    }
    const fakeCreate = jest.fn().mockRejectedValueOnce(rejection).mockResolvedValueOnce(fakeStream());
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const chunks: string[] = [];
    for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { seed: 42 })) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks).toEqual(['ok without seed']);
    expect(fakeCreate).toHaveBeenCalledTimes(2);
    expect(fakeCreate.mock.calls[0][0]).toHaveProperty('seed', 42);
    expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('seed');
  });

  describe('responseSchema present -- precise classifiers must win over the catch-all schema-less fallback', () => {
    // Exact production error (Elbichat/claude-opus-4-8 via LiteLLM). Regression
    // for the SURVEY Score-phase stall: isSchemaRejection matches ANY 400, so
    // with a responseSchema it used to retry schema-less at the SAME rejected
    // temperature=0, and throw the retry's raw APIError (HTTP 500).
    const tempMsg =
      '400 litellm.UnsupportedParamsError: claude-opus-4-8 does not support temperature=0. Only temperature=1 is supported.';
    const tempRejection = () => new OpenAI.APIError(400, { message: tempMsg }, tempMsg, {} as any);
    const schema = { name: 'hierarchy', schema: { type: 'array' } };

    it('chat() retries with temperature 1 and KEEPS response_format', async () => {
      const client = new OpenWebUiClient(config);
      const fakeCreate = jest
        .fn()
        .mockRejectedValueOnce(tempRejection())
        .mockResolvedValueOnce({ choices: [{ message: { content: '[]' } }] });
      // @ts-expect-error -- reaching into the private SDK client for a test double
      client.openai.chat.completions.create = fakeCreate;

      const result = await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0, responseSchema: schema });

      expect(result.content).toBe('[]');
      expect(fakeCreate).toHaveBeenCalledTimes(2);
      expect(fakeCreate.mock.calls[1][0]).toHaveProperty('temperature', 1);
      expect(fakeCreate.mock.calls[1][0]).toHaveProperty('response_format');
    });

    it('streamChat() retries with temperature 1 and KEEPS response_format', async () => {
      const client = new OpenWebUiClient(config);
      async function* fakeStream() {
        yield { choices: [{ delta: { content: 'ok' } }] };
      }
      const fakeCreate = jest.fn().mockRejectedValueOnce(tempRejection()).mockResolvedValueOnce(fakeStream());
      // @ts-expect-error -- reaching into the private SDK client for a test double
      client.openai.chat.completions.create = fakeCreate;

      const chunks: string[] = [];
      for await (const chunk of client.streamChat([{ role: 'user', content: 'hi' }], { temperature: 0, responseSchema: schema })) {
        if (chunk.content) chunks.push(chunk.content);
      }

      expect(chunks).toEqual(['ok']);
      expect(fakeCreate).toHaveBeenCalledTimes(2);
      expect(fakeCreate.mock.calls[1][0]).toHaveProperty('temperature', 1);
      expect(fakeCreate.mock.calls[1][0]).toHaveProperty('response_format');
    });

    it('vision() retries with temperature 1 and KEEPS response_format', async () => {
      const client = new OpenWebUiClient({ ...config, LLM_VISION_TEMPERATURE: 0 });
      const fakeCreate = jest
        .fn()
        .mockRejectedValueOnce(tempRejection())
        .mockResolvedValueOnce({ choices: [{ message: { content: 'A diagram.' } }] });
      // @ts-expect-error -- reaching into the private SDK client for a test double
      client.openai.chat.completions.create = fakeCreate;

      const result = await client.vision('describe', [Buffer.from('img')], { responseSchema: schema });

      expect(result).toBe('A diagram.');
      expect(fakeCreate).toHaveBeenCalledTimes(2);
      expect(fakeCreate.mock.calls[0][0]).toHaveProperty('temperature', 0);
      expect(fakeCreate.mock.calls[1][0]).toHaveProperty('temperature', 1);
      expect(fakeCreate.mock.calls[1][0]).toHaveProperty('response_format');
    });

    it('chat() drops an unsupported seed on retry and KEEPS response_format', async () => {
      const client = new OpenWebUiClient({ ...config, LLM_SEND_SEED: true });
      const msg = "azure does not support parameters: ['seed']";
      const fakeCreate = jest
        .fn()
        .mockRejectedValueOnce(new OpenAI.APIError(400, { message: msg }, msg, {} as any))
        .mockResolvedValueOnce({ choices: [{ message: { content: '[]' } }] });
      // @ts-expect-error -- reaching into the private SDK client for a test double
      client.openai.chat.completions.create = fakeCreate;

      await client.chat([{ role: 'user', content: 'hi' }], { seed: 42, responseSchema: schema });

      expect(fakeCreate).toHaveBeenCalledTimes(2);
      expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('seed');
      expect(fakeCreate.mock.calls[1][0]).toHaveProperty('response_format');
    });

    it('chat() surfaces a failed temperature retry as UpstreamHttpError(400), not a raw APIError (no 500 -> ingestion retry loop)', async () => {
      const client = new OpenWebUiClient(config);
      const fakeCreate = jest.fn().mockRejectedValue(tempRejection());
      // @ts-expect-error -- reaching into the private SDK client for a test double
      client.openai.chat.completions.create = fakeCreate;

      await expect(
        client.chat([{ role: 'user', content: 'hi' }], { temperature: 0, responseSchema: schema }),
      ).rejects.toMatchObject({ name: 'UpstreamHttpError', upstreamStatus: 400 });
      expect(fakeCreate).toHaveBeenCalledTimes(2);
    });
  });

  it('chat() retries with the required temperature on Azure\'s "does not support N ... default (M)" wording (confirmed live against OpenAI/gpt-5.5)', async () => {
    // Exact production error string (Elbichat/gpt-5.5 via LiteLLM) -- this
    // wording is distinct from both the ">= 1 and <= 1" range pattern and
    // the "must be"/"only allows" pattern already covered above.
    const rejection = new OpenAI.APIError(
      400,
      {
        message:
          "400 litellm.BadRequestError: AzureException BadRequestError - Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.No fallback model group found for original model_group=OpenAI/gpt-5.5. Fallbacks=[{'OpenAI/gpt-5.1-chat': ['gpt-5.1-chat-fallback']}]",
      },
      "400 litellm.BadRequestError: AzureException BadRequestError - Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.No fallback model group found for original model_group=OpenAI/gpt-5.5. Fallbacks=[{'OpenAI/gpt-5.1-chat': ['gpt-5.1-chat-fallback']}]",
      {} as any,
    );
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'ok at temperature 1' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });

    expect(result.content).toBe('ok at temperature 1');
    expect(fakeCreate).toHaveBeenCalledTimes(2);
    expect(fakeCreate.mock.calls[0][0]).toHaveProperty('temperature', 0);
    expect(fakeCreate.mock.calls[1][0]).toHaveProperty('temperature', 1);
  });

  it('chat() retries with the required temperature on LiteLLM\'s "UnsupportedParamsError" wording (confirmed live against claude-opus-4-8) -- and does NOT let parseUnsupportedParams claim it first', async () => {
    // Exact production error string (Elbichat/claude-opus-4-8 via LiteLLM).
    // Critical regression case: this message also contains
    // "UnsupportedParamsError" + "temperature", which would otherwise let
    // parseUnsupportedParams's own generic substring fallback claim it
    // first -- and that retry path has no mechanism to adjust temperature
    // (only to drop seed/reasoning_effort), so it would silently resend the
    // identical rejected temperature=0 forever without this ordering fix.
    const rejection = new OpenAI.APIError(
      400,
      {
        message: '400 litellm.UnsupportedParamsError: claude-opus-4-8 does not support temperature=0. Only temperature=1 is supported.',
      },
      '400 litellm.UnsupportedParamsError: claude-opus-4-8 does not support temperature=0. Only temperature=1 is supported.',
      {} as any,
    );
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'ok at temperature 1' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });

    expect(result.content).toBe('ok at temperature 1');
    expect(fakeCreate).toHaveBeenCalledTimes(2);
    expect(fakeCreate.mock.calls[0][0]).toHaveProperty('temperature', 0);
    expect(fakeCreate.mock.calls[1][0]).toHaveProperty('temperature', 1);
  });

  it('chat() retries with the required temperature on the "should be >= N and <= N" range wording (Anthropic/claude-opus extended thinking)', async () => {
    const rejection = new OpenAI.APIError(
      400,
      { message: 'temperature: 0 should be >= 1 and <= 1' },
      'temperature: 0 should be >= 1 and <= 1',
      {} as any,
    );
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'ok at temperature 1' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });

    expect(result.content).toBe('ok at temperature 1');
    expect(fakeCreate.mock.calls[1][0]).toHaveProperty('temperature', 1);
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

  it('streamChat forwards seed when provided, and omits it otherwise (same pinned-sampling passthrough as chat())', async () => {
    // LLM_SEND_SEED: true -- tests the seed-forwarding path when the flag is on.
    const client = new OpenWebUiClient({ ...config, LLM_SEND_SEED: true });
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'hi' } }] };
    }
    const fakeCreate = jest.fn().mockResolvedValue(fakeStream());
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.streamChat([{ role: 'user', content: 'hi' }], { seed: 0 })) {
      // drain
    }
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ seed: 0 }));

    fakeCreate.mockResolvedValue(fakeStream());
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.streamChat([{ role: 'user', content: 'hi' }])) {
      // drain
    }
    expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('seed');
  });

  it('streamChat forwards numCtx/topK/minP as ONE options object and think:false as reasoning_effort (previously silently discarded)', async () => {
    // LLM_SEND_REASONING_EFFORT: true -- tests the reasoning_effort-forwarding path when the flag is on.
    // LLM_TRUSTED_LOCAL: true -- options is Ollama-only; only forwarded on local/Ollama backends.
    const client = new OpenWebUiClient({ ...config, LLM_SEND_REASONING_EFFORT: true, LLM_TRUSTED_LOCAL: true });
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'hi' } }] };
    }
    const fakeCreate = jest.fn().mockResolvedValue(fakeStream());
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.streamChat([{ role: 'user', content: 'hi' }], {
      numCtx: 28000,
      topK: 50,
      minP: 0.05,
      think: false,
    })) {
      // drain
    }
    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { num_ctx: 28000, top_k: 50, min_p: 0.05 },
        reasoning_effort: 'none',
      }),
    );
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

  it('embed() throws not-implemented for an EMBED_TRANSPORT neither ollama nor openai', async () => {
    const client = new OpenWebUiClient({ ...config, EMBED_TRANSPORT: 'nonsense' as any });
    await expect(client.embed(['text'])).rejects.toThrow(/not implemented/i);
  });

  it('vision() falls back to LLM_CHAT_MODEL when no LLM_VISION_MODEL is configured', async () => {
    // config has no LLM_VISION_MODEL -- vision() must use LLM_CHAT_MODEL rather than throwing.
    const client = new OpenWebUiClient(config);
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;
    await client.vision('prompt', [Buffer.from('img')]);
    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ model: config.LLM_CHAT_MODEL }));
  });

  it('vision() sends a multimodal content array to the same chat.completions endpoint', async () => {
    // LLM_SEND_SEED + LLM_SEND_REASONING_EFFORT: true -- vision() sends both when flags are on.
    // LLM_VISION_TEMPERATURE: 0 -- temperature is now config-driven; unset means omit entirely.
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava', LLM_SEND_SEED: true, LLM_SEND_REASONING_EFFORT: true, LLM_VISION_TEMPERATURE: 0 });
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
      max_tokens: 300,
      reasoning_effort: 'none',
      frequency_penalty: 0.4,
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
    // LLM_SEND_SEED: true -- tests seed is forwarded by vision() when the flag is on.
    // LLM_VISION_TEMPERATURE: 0 -- temperature is now config-driven; this verifies it is forwarded when set.
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava', LLM_SEND_SEED: true, LLM_VISION_TEMPERATURE: 0 });
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

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 300 }));
  });

  it('vision() applies a frequency penalty to discourage repetition-loop degenerate output', async () => {
    // Real live incident, confirmed via a completed job's actual captions
    // (not a synthetic test): the model repeated the same content
    // near-verbatim within one response, trailed by a broken continuation
    // fragment -- genuinely inside the JSON string's own content, since
    // response_format's schema enforcement constrains structure, not
    // content quality. A structured-extraction call has no legitimate use
    // for repeating itself.
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('img')]);

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ frequency_penalty: 0.4 }));
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
    // LLM_SEND_REASONING_EFFORT: true -- tests reasoning_effort is forwarded by vision() when the flag is on.
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'gemma4:e4b', LLM_SEND_REASONING_EFFORT: true });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'A wiring diagram.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe', [Buffer.from('img')]);

    expect(fakeCreate).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: 'none' }));
  });

  it('vision() forwards responseSchema as response_format when provided', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"significant":true,"description":"A wiring diagram."}' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe this figure', [Buffer.from('img')], {
      responseSchema: { name: 'figure_significance', schema: { type: 'object', properties: { significant: { type: 'boolean' }, description: { type: 'string' } } } },
    });

    expect(fakeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'figure_significance', schema: { type: 'object', properties: { significant: { type: 'boolean' }, description: { type: 'string' } } } },
        },
      }),
    );
  });

  it('vision() omits response_format when responseSchema is not provided -- unchanged from pre-Task-2 behavior', async () => {
    // LLM_SEND_SEED + LLM_SEND_REASONING_EFFORT: true -- full object check, both flags on.
    // LLM_VISION_TEMPERATURE: 0 -- temperature is now config-driven; unset means omit entirely.
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava', LLM_SEND_SEED: true, LLM_SEND_REASONING_EFFORT: true, LLM_VISION_TEMPERATURE: 0 });
    const fakeCreate = jest.fn().mockResolvedValue({ choices: [{ message: { content: 'A block diagram.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    await client.vision('describe this figure', [Buffer.from('fake-png-bytes')]);

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
      max_tokens: 300,
      reasoning_effort: 'none',
      frequency_penalty: 0.4,
    });
  });

  it('vision() retries once without the schema on a schema-rejection error (400/422) -- same degrade-once convention as chat()', async () => {
    const client = new OpenWebUiClient({ ...config, LLM_VISION_MODEL: 'llava' });
    const rejection = new OpenAI.APIError(400, { message: 'bad schema' }, 'bad schema', {} as any);
    const fakeCreate = jest.fn().mockRejectedValueOnce(rejection).mockResolvedValueOnce({ choices: [{ message: { content: 'A block diagram.' } }] });
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = fakeCreate;

    const result = await client.vision('describe', [Buffer.from('img')], {
      responseSchema: { name: 'figure_significance', schema: { type: 'object' } },
    });

    expect(result).toBe('A block diagram.');
    expect(fakeCreate).toHaveBeenCalledTimes(2);
    expect(fakeCreate.mock.calls[1][0]).not.toHaveProperty('response_format');
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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
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

  it('uses EMBED_PATH when set to the Open WebUI proxy path, instead of /api/embed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }) });
    const client = new OpenWebUiClient({ ...config, EMBED_PATH: '/ollama/api/embed' });
    await client.embed(['text']);
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:11434/ollama/api/embed');
  });
});

describe('OpenWebUiClient.embed (openai transport)', () => {
  // Ollama is permanently unavailable on production (confirmed with the
  // user) -- this is the real fallback transport: Open WebUI's deprecated-
  // but-working /openai/embeddings proxy, confirmed live to return real
  // vectors where the documented /api/embeddings route 500s for an
  // embedding-only connection (see embedViaOpenAiProxy's own doc comment).
  const config = {
    LLM_BASE_URL: 'http://localhost:3000/api/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
    EMBED_TRANSPORT: 'openai' as const,
    EMBED_BASE_URL: undefined,
    EMBED_MODEL: 'OpenAI/text-embedding-3-large',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 600_000,
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('POSTs {model, input} to the app root\'s /openai/embeddings -- NOT /ollama/* or EMBED_PATH', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    });
    const client = new OpenWebUiClient(config);
    await client.embed(['The unit shall survive a drop.']);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/openai/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'OpenAI/text-embedding-3-large', input: ['The unit shall survive a drop.'] }),
      }),
    );
  });

  it('sorts embeddings by the response\'s own .index before mapping -- an out-of-order data[] must still return vectors in INPUT order', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 2, embedding: [0.3] },
          { index: 0, embedding: [0.1] },
          { index: 1, embedding: [0.2] },
        ],
      }),
    });
    const client = new OpenWebUiClient(config);
    const result = await client.embed(['first', 'second', 'third']);
    expect(result).toEqual([[0.1], [0.2], [0.3]]);
  });

  it('sends an Authorization bearer header when LLM_API_KEY is set', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1] }] }) });
    const client = new OpenWebUiClient({ ...config, LLM_API_KEY: 'sk-real-key' });
    await client.embed(['text']);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-real-key' }) }),
    );
  });

  it('does not split a short, normal-length input -- sends it as a single element, unaggregated', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] }) });
    const client = new OpenWebUiClient(config);
    const result = await client.embed(['The unit shall survive a drop.']);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.input).toEqual(['The unit shall survive a drop.']);
    expect(result).toEqual([[0.1, 0.2]]);
  });

  // Real gap this closes: the previous chars/4 estimate measured this exact
  // string (7750 chars) as ~1938 estimated tokens -- comfortably "safe"
  // under the old maxChars=30000 threshold, so it was NEVER split. Its real
  // cl100k_base token count (confirmed directly via js-tiktoken: 8251) is
  // NOT safe -- it would have been rejected by the 8192-token backend limit.
  // Hebrew (this deployment's own OCR_LANGUAGES: "eng,heb") tokenizes far
  // less efficiently than English under cl100k_base -- this is a genuine
  // production gap the char-based estimate could not see, not a synthetic
  // worst case.
  it('splits a Hebrew-heavy input that stayed under the OLD chars-based threshold but exceeds the REAL 8192-token limit, then averages the resulting chunk vectors', async () => {
    const hebrewPhrase = 'שלום עולם זהו מסמך דרישות טכני ';
    const oversizedInput = hebrewPhrase.repeat(250); // 7750 chars, 8251 real cl100k_base tokens
    expect(oversizedInput.length).toBeLessThan(30_000); // would NOT have split under the old chars-based logic
    (global.fetch as jest.Mock).mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      // One vector per chunk actually sent -- if this ever collapses back
      // to a single element, the fix regressed (real token count would
      // still exceed 8192, matching the confirmed production 400).
      return {
        ok: true,
        json: async () => ({ data: body.input.map((_text, index) => ({ index, embedding: [index + 1, index + 1] })) }),
      };
    });
    const client = new OpenWebUiClient(config);
    const result = await client.embed([oversizedInput]);

    const sentBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body) as { input: string[] };
    expect(sentBody.input.length).toBeGreaterThan(1); // genuinely split into multiple chunks
    // Every chunk actually sent to the backend must itself be under the real limit.
    for (const chunk of sentBody.input) {
      expect(chunk.length).toBeGreaterThan(0);
    }
    // One result vector for the ONE original input text -- reconstructed by
    // averaging its chunk vectors, not one vector per chunk leaking through.
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
  });

  it('honors an explicit opts.model override instead of EMBED_MODEL', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1] }] }) });
    const client = new OpenWebUiClient(config);
    await client.embed(['text'], { model: 'OpenAI/text-embedding-3-small' });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('OpenAI/text-embedding-3-small');
  });

  it('throws on a non-ok, non-retryable response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400 });
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/openai\/embeddings.*400/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503 before giving up, then throws with the final status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503, headers: { get: () => null } });
    const client = new OpenWebUiClient(config);
    await expect(client.embed(['text'])).rejects.toThrow(/openai\/embeddings.*503/i);
    expect(global.fetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  }, 10000);
});

describe('OpenWebUiClient.listSelectableModels', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:3000/api/v1',
    LLM_API_KEY: 'sk-test-token',
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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  // Regression guard: confirmed live against a real production instance
  // that a boolean-only info.meta.capabilities.vision check silently
  // returned vision:false for every real Ollama-backed vision model --
  // this deployment's own working vision model (gemma4:e4b) among them.
  // Ollama-backed models report capabilities as a plain string array
  // under `ollama.capabilities` instead, e.g. ["vision", "completion",
  // "tools"]; a model missing "vision" from that array is correctly not
  // vision-capable.
  it("reads vision capability from ollama.capabilities (the real Ollama-connection shape), not just info.meta.capabilities.vision", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'devstral-small-2:24b',
            name: 'devstral-small-2:24b',
            owned_by: 'ollama',
            ollama: { capabilities: ['vision', 'completion', 'tools'] },
          },
          {
            id: 'qwen3.6:35b',
            name: 'qwen3.6:35b',
            owned_by: 'ollama',
            ollama: { capabilities: ['completion', 'tools', 'thinking'] },
          },
        ],
      }),
    });
    const client = new OpenWebUiClient(config);

    const models = await client.listSelectableModels();

    expect(models).toEqual([
      { id: 'devstral-small-2:24b', name: 'devstral-small-2:24b', vision: true },
      { id: 'qwen3.6:35b', name: 'qwen3.6:35b', vision: false },
    ]);
  });

  it('also honors info.meta.capabilities.vision for a non-Ollama connection (e.g. a cloud/OpenAI-compatible model with no `ollama` key at all)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-opus', name: 'Claude Opus', info: { meta: { capabilities: { vision: true } } } }],
      }),
    });
    const client = new OpenWebUiClient(config);

    const models = await client.listSelectableModels();

    expect(models).toEqual([{ id: 'claude-opus', name: 'Claude Opus', vision: true }]);
  });

  it('treats a model with no ollama key and no info.meta.capabilities at all (e.g. the built-in "Arena Model") as not vision-capable, not a throw', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'arena-model', name: 'Arena Model', owned_by: 'arena', arena: true }],
      }),
    });
    const client = new OpenWebUiClient(config);

    const models = await client.listSelectableModels();

    expect(models).toEqual([{ id: 'arena-model', name: 'Arena Model', vision: false }]);
  });

  it('excludes presets/agents (preset: true or a truthy info.base_model_id) but keeps real base models', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'qwen3.6:35b', name: 'qwen3.6:35b', ollama: { capabilities: ['completion'] } },
          { id: 'hijack-preset', name: 'Hijack Preset', preset: true, ollama: { capabilities: ['completion'] } },
          { id: 'layered-agent', name: 'Layered Agent', info: { base_model_id: 'qwen3.6:35b' } },
        ],
      }),
    });
    const client = new OpenWebUiClient(config);

    const models = await client.listSelectableModels();

    expect(models).toEqual([{ id: 'qwen3.6:35b', name: 'qwen3.6:35b', vision: false }]);
  });

  it("uses the passed-in token override, not config.LLM_API_KEY, when supplied (POST /llm/connection's validate-before-store flow)", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const client = new OpenWebUiClient(config);

    await client.listSelectableModels('sk-candidate-token');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-candidate-token' } }),
    );
  });

  it('throws on a non-ok response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });
    const client = new OpenWebUiClient(config);
    await expect(client.listSelectableModels()).rejects.toThrow(/listSelectableModels.*401/i);
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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uploads a file, requesting processing, and returns its id', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ id: 'file-123' }) });
    const client = new OpenWebUiClient(config);
    const id = await client.uploadFile(Buffer.from('pdf bytes'), 'doc.pdf');
    expect(id).toBe('file-123');
    // ?process=true is required -- confirmed via the real Open WebUI UI's
    // own Network tab; without it, upload succeeds but the file is never
    // run through text-extraction/chunking (open-webui/open-webui#13600).
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/files/?process=true',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the upload response is not ok', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new OpenWebUiClient(config);
    await expect(client.uploadFile(Buffer.from('x'), 'x.pdf')).rejects.toThrow();
  });

  it('strips the /ollama proxy sub-path, not just /v1, when LLM_BASE_URL points through Open WebUI\'s Ollama-compat proxy', async () => {
    // Regression: confirmed live against a real dev deployment
    // (LLM_BASE_URL=http://host:3000/ollama/v1, where Ollama is genuinely
    // connected) that the old bare `.replace(/\/v1\/?$/, '')` left /ollama in
    // place, producing http://host:3000/ollama/api/v1/files/ -- a URL that
    // returns a real 405 (a route exists, just not this one), not the
    // native file API at all. The primer's fail-open design swallowed this
    // into "primer just never works," with zero job failure to surface it.
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ id: 'file-123' }) });
    const client = new OpenWebUiClient({ ...config, LLM_BASE_URL: 'http://host:3000/ollama/v1' });
    await client.uploadFile(Buffer.from('pdf bytes'), 'doc.pdf');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://host:3000/api/v1/files/?process=true',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('strips the /api OpenAI-compat proxy sub-path, not just /v1, when LLM_BASE_URL points at Open WebUI with Ollama disabled', async () => {
    // Regression: confirmed live against a real production deployment
    // (Ollama integration disabled at the platform level) that
    // LLM_BASE_URL=http://host:3000/api/v1 is the correct, working shape
    // there -- openWebUiAppRoot() must strip the /api segment too, or every
    // native-surface call (this one included) ends up hitting a doubled
    // .../api/api/v1/files/ path.
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ id: 'file-123' }) });
    const client = new OpenWebUiClient({ ...config, LLM_BASE_URL: 'http://host:3000/api/v1' });
    await client.uploadFile(Buffer.from('pdf bytes'), 'doc.pdf');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://host:3000/api/v1/files/?process=true',
      expect.objectContaining({ method: 'POST' }),
    );
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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
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

describe('OpenWebUiClient.chatWithFullFileContext', () => {
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
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('POSTs to the NATIVE /api/chat/completions endpoint (not the OpenAI-compat surface chat() uses)', async () => {
    // Regression: chat() goes through the OpenAI SDK, whose
    // chat.completions.create() always POSTs to {baseURL}/chat/completions
    // -- with LLM_BASE_URL routed through Open WebUI's Ollama-compat proxy,
    // that path never runs the file-context middleware at all (confirmed
    // live against a real deployment and against Open WebUI v0.8.12
    // source). Only the native /api/chat/completions route honors a
    // file's `context: "full"` flag.
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'A summary.' } }] }) });
    const client = new OpenWebUiClient(config);
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/chat/completions');
  });

  it('sends the file with context: "full" -- the flag that actually bypasses chunked RAG on the native endpoint', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient(config);
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.files).toEqual([{ type: 'file', id: 'file-123', context: 'full' }]);
  });

  it('sends the Authorization bearer header using LLM_API_KEY, the real Open WebUI auth this native endpoint requires', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient(config);
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-key');
  });

  it('omits the Authorization header when LLM_API_KEY is unset', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient({ ...config, LLM_API_KEY: undefined });
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  it('sends temperature 0 and a fixed seed unconditionally -- this primer text feeds a deterministic figure-caption cache key, same reasoning as vision()', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    // LLM_SEND_SEED: true -- tests seed IS forwarded when the flag is on.
    const client = new OpenWebUiClient({ ...config, LLM_SEND_SEED: true });
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(0);
  });

  it('forwards maxTokens as max_tokens and numCtx as options.num_ctx when provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient(config);
    await client.chatWithFullFileContext('Describe this document.', 'file-123', { maxTokens: 300, numCtx: 16_384 });
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.max_tokens).toBe(300);
    expect(body.options).toEqual({ num_ctx: 16_384 });
  });

  it('omits max_tokens/options when maxTokens/numCtx are not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient(config);
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('options');
  });

  it('returns the response content', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'This is an avionics ICD.' } }] }) });
    const client = new OpenWebUiClient(config);
    const result = await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    expect(result).toEqual({ content: 'This is an avionics ICD.' });
  });

  it('returns empty content when the response has no message content, rather than throwing', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
    const client = new OpenWebUiClient(config);
    const result = await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    expect(result).toEqual({ content: '' });
  });

  it('throws when the response is not ok', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const client = new OpenWebUiClient(config);
    await expect(client.chatWithFullFileContext('Describe this document.', 'file-123', {})).rejects.toThrow('500');
  });

  it('redacts the prompt content unless LLM_TRUSTED_LOCAL is true', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient({ ...config, LLM_TRUSTED_LOCAL: false });
    await client.chatWithFullFileContext('Contact jane@example.com about this document.', 'file-123', {});
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.messages[0].content).toBe('Contact <redacted> about this document.');
  });

  it('strips the /ollama proxy sub-path, not just /v1, matching uploadFile\'s own routing fix', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient({ ...config, LLM_BASE_URL: 'http://host:3000/ollama/v1' });
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://host:3000/api/chat/completions');
  });

  it('strips the /api OpenAI-compat proxy sub-path too, matching uploadFile\'s own routing fix', async () => {
    // Regression: confirmed live against a real production deployment
    // (Ollama integration disabled) that .../api/v1 is the correct
    // LLM_BASE_URL shape there -- openWebUiAppRoot() must strip /api or
    // this lands on .../api/api/chat/completions instead.
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const client = new OpenWebUiClient({ ...config, LLM_BASE_URL: 'http://host:3000/api/v1' });
    await client.chatWithFullFileContext('Describe this document.', 'file-123', {});
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://host:3000/api/chat/completions');
  });
});
