import OpenAI from 'openai';
import { isModelHidden, parseModelHidePatterns } from '../src/modules/llm/model-visibility';
import { ModelInfoUnavailableError, OpenWebUiClient } from '../src/modules/llm/openwebui.client';
import {
  effectiveMaxTokens,
  isToolsWithReasoningRejection,
  parseMaxOutputCap,
  parseMaxTokensUnsupported,
  raisedBudgetFor,
  type Adaptation,
} from '../src/modules/llm/upstream-negotiation';

// Newer model families (GPT-5.x/6 reasoning models on Azure OpenAI, Claude 5) differ in which parameters they
// accept. These tests use the error wordings the vendors document; the parsers must be tolerant about phrasing
// and the client must remember what a model taught it.

const apiError = (message: string, status = 400) => new OpenAI.APIError(status, { message }, message, {} as any);

const AZURE_MAX_TOKENS =
  "400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
const LITELLM_MAX_TOKENS = "400 litellm.UnsupportedParamsError: azure does not support parameters: ['max_tokens']";
const OPENAI_TOO_LARGE =
  '400 max_tokens is too large: 200000. This model supports at most 16384 completion tokens, whereas you provided 200000.';
const ANTHROPIC_TOO_LARGE =
  '400 max_tokens: 20000 > 8192, which is the maximum allowed number of output tokens for claude-3-haiku-20240307';
const TOOLS_REASONING =
  "400 Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

describe('negotiation parsers (documented wordings)', () => {
  it('recognises max_tokens being refused in favour of max_completion_tokens', () => {
    expect(parseMaxTokensUnsupported(apiError(AZURE_MAX_TOKENS))).toBe(true);
    expect(parseMaxTokensUnsupported(apiError(LITELLM_MAX_TOKENS))).toBe(true);
    expect(parseMaxTokensUnsupported(apiError("Unsupported parameter: 'max_tokens'. Please use max_completion_tokens"))).toBe(true);
  });

  it('does not mistake an output-ceiling error, a temperature error or a non-400 for it', () => {
    expect(parseMaxTokensUnsupported(apiError(OPENAI_TOO_LARGE))).toBe(false);
    expect(parseMaxTokensUnsupported(apiError('temperature must be 1'))).toBe(false);
    expect(parseMaxTokensUnsupported(apiError(AZURE_MAX_TOKENS, 500))).toBe(false);
    expect(parseMaxTokensUnsupported(new Error(AZURE_MAX_TOKENS))).toBe(false);
  });

  it('reads the stated output ceiling from OpenAI, Azure and Anthropic wordings', () => {
    expect(parseMaxOutputCap(apiError(OPENAI_TOO_LARGE))).toBe(16384);
    expect(parseMaxOutputCap(apiError(ANTHROPIC_TOO_LARGE))).toBe(8192);
    expect(parseMaxOutputCap(apiError('max_completion_tokens must be less than or equal to 32,768'))).toBe(32768);
    expect(parseMaxOutputCap(apiError('Invalid value for max_tokens: the maximum allowed is 4096'))).toBe(4096);
  });

  it('returns null for errors that state no ceiling', () => {
    expect(parseMaxOutputCap(apiError('Something else went wrong'))).toBeNull();
    expect(parseMaxOutputCap(apiError(OPENAI_TOO_LARGE, 500))).toBeNull();
    expect(parseMaxOutputCap(undefined)).toBeNull();
  });

  it('recognises the gpt-5.6 function-tools-with-reasoning refusal', () => {
    expect(isToolsWithReasoningRejection(apiError(TOOLS_REASONING))).toBe(true);
    expect(isToolsWithReasoningRejection(apiError('tools are not supported with reasoning_effort, set it to "none"'))).toBe(true);
    expect(isToolsWithReasoningRejection(apiError('temperature must be 1'))).toBe(false);
  });

  const adaptation = (over: Partial<Adaptation> = {}): Adaptation => ({
    temperature: undefined,
    dropped: new Set(),
    dropSchema: false,
    tokenParam: 'max_tokens',
    omitTokenLimit: false,
    maxTokensCap: undefined,
    maxTokensFloor: undefined,
    forceReasoningNone: false,
    attempt: 1,
    ...over,
  });

  it('sends no limit at all once the model has refused both parameters', () => {
    expect(effectiveMaxTokens(20000, adaptation({ omitTokenLimit: true }))).toBeUndefined();
    expect(raisedBudgetFor(50, adaptation({ omitTokenLimit: true }))).toBeNull();
  });

  it('applies the raised floor first and the learned ceiling last', () => {
    expect(effectiveMaxTokens(undefined, adaptation())).toBeUndefined();
    expect(effectiveMaxTokens(50, adaptation())).toBe(50);
    expect(effectiveMaxTokens(50, adaptation({ maxTokensFloor: 200 }))).toBe(200);
    expect(effectiveMaxTokens(20000, adaptation({ maxTokensCap: 16384 }))).toBe(16384);
    expect(effectiveMaxTokens(50, adaptation({ maxTokensFloor: 200_000, maxTokensCap: 16384 }))).toBe(16384);
  });

  it('proposes a raised budget once, within the ceiling, and never above what was sent', () => {
    expect(raisedBudgetFor(50, adaptation())).toBe(4000);
    expect(raisedBudgetFor(1000, adaptation())).toBe(4000);
    expect(raisedBudgetFor(20000, adaptation())).toBe(64000);
    expect(raisedBudgetFor(50, adaptation({ maxTokensFloor: 4000 }))).toBeNull();
    expect(raisedBudgetFor(16384, adaptation({ maxTokensCap: 16384 }))).toBeNull();
    expect(raisedBudgetFor(undefined, adaptation())).toBeNull();
  });
});

describe('OpenWebUiClient model negotiation', () => {
  const config = {
    LLM_BASE_URL: 'http://localhost:11434/v1',
    LLM_API_KEY: undefined,
    LLM_CHAT_MODEL: 'llama3.1',
    LLM_TRUSTED_LOCAL: false,
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
  const ok = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
  const emptyLength = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
  const user = [{ role: 'user' as const, content: 'hi' }];

  const makeClient = (create: jest.Mock, overrides: Record<string, unknown> = {}) => {
    const client = new OpenWebUiClient({ ...config, ...overrides } as any);
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.chat.completions.create = create;
    return client;
  };

  it('switches to max_completion_tokens when max_tokens is refused, and remembers it for the model', async () => {
    const create = jest.fn().mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS)).mockResolvedValue(ok);
    const client = makeClient(create);

    await client.chat(user, { model: 'gpt-chat-latest', maxTokens: 20000 });
    await client.chat(user, { model: 'gpt-chat-latest', maxTokens: 20000 });

    expect(create.mock.calls[0][0]).toHaveProperty('max_tokens', 20000);
    expect(create.mock.calls[1][0]).toHaveProperty('max_completion_tokens', 20000);
    expect(create.mock.calls[1][0]).not.toHaveProperty('max_tokens');
    expect(create).toHaveBeenCalledTimes(3); // the second call needed no retry
    expect(create.mock.calls[2][0]).toHaveProperty('max_completion_tokens', 20000);
  });

  it('does not carry what one model taught onto another', async () => {
    const create = jest.fn().mockRejectedValueOnce(apiError(LITELLM_MAX_TOKENS)).mockResolvedValue(ok);
    const client = makeClient(create);

    await client.chat(user, { model: 'gpt-chat-latest', maxTokens: 100 });
    await client.chat(user, { model: 'claude-sonnet-4-6', maxTokens: 100 });

    expect(create.mock.calls[2][0]).toHaveProperty('max_tokens', 100);
    expect(create.mock.calls[2][0]).not.toHaveProperty('max_completion_tokens');
  });

  it('clamps to a stated output ceiling and remembers it', async () => {
    const create = jest.fn().mockRejectedValueOnce(apiError(OPENAI_TOO_LARGE)).mockResolvedValue(ok);
    const client = makeClient(create);

    await client.chat(user, { model: 'gpt-5.1-chat', maxTokens: 20000 });
    await client.chat(user, { model: 'gpt-5.1-chat', maxTokens: 20000 });

    expect(create.mock.calls[1][0]).toHaveProperty('max_tokens', 16384);
    expect(create.mock.calls[2][0]).toHaveProperty('max_tokens', 16384);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('composes: max_tokens refused, then a ceiling, then success -- in one call', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS))
      .mockRejectedValueOnce(apiError(OPENAI_TOO_LARGE))
      .mockResolvedValueOnce(ok);
    const client = makeClient(create);

    const result = await client.chat(user, { model: 'gpt-5.1-chat', maxTokens: 200000 });

    expect(result.content).toBe('ok');
    expect(create.mock.calls[2][0]).toHaveProperty('max_completion_tokens', 16384);
    expect(create.mock.calls[2][0]).not.toHaveProperty('max_tokens');
  });

  it('retries a tools request with reasoning_effort none when the model refuses tools while reasoning', async () => {
    const create = jest.fn().mockRejectedValueOnce(apiError(TOOLS_REASONING)).mockResolvedValue(ok);
    const client = makeClient(create);
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: { type: 'object' } } }];

    await client.chat(user, { model: 'OpenAI/gpt-5.6-sol', tools });
    await client.chat(user, { model: 'OpenAI/gpt-5.6-sol', tools });

    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');
    expect(create.mock.calls[1][0]).toHaveProperty('reasoning_effort', 'none');
    expect(create.mock.calls[2][0]).toHaveProperty('reasoning_effort', 'none'); // learned, no second refusal
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('never adds reasoning_effort to a request without tools, even for a model that learned the rule', async () => {
    const create = jest.fn().mockRejectedValueOnce(apiError(TOOLS_REASONING)).mockResolvedValue(ok);
    const client = makeClient(create);
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: { type: 'object' } } }];

    await client.chat(user, { model: 'OpenAI/gpt-5.6-sol', tools });
    await client.chat(user, { model: 'OpenAI/gpt-5.6-sol' });

    expect(create.mock.calls[2][0]).not.toHaveProperty('reasoning_effort');
  });

  it('drops temperature for a model that says it is an unsupported parameter, rather than failing', async () => {
    const message = "400 Unsupported parameter: 'temperature' is not supported with this model.";
    const create = jest.fn().mockRejectedValueOnce(apiError(message)).mockResolvedValue(ok);
    const client = makeClient(create);

    await client.chat(user, { model: 'OpenAI/gpt-6-astra', temperature: 0 });
    await client.chat(user, { model: 'OpenAI/gpt-6-astra', temperature: 0 });

    expect(create.mock.calls[0][0]).toHaveProperty('temperature', 0);
    expect(create.mock.calls[1][0]).not.toHaveProperty('temperature');
    expect(create.mock.calls[2][0]).not.toHaveProperty('temperature');
  });

  it('still honours a model that demands a temperature value (the existing path wins over dropping)', async () => {
    const message = "400 'temperature' does not support 0 with this model. Only the default (1) value is supported.";
    const create = jest.fn().mockRejectedValueOnce(apiError(message)).mockResolvedValue(ok);
    const client = makeClient(create);

    await client.chat(user, { model: 'OpenAI/gpt-5.5', temperature: 0 });

    expect(create.mock.calls[1][0]).toHaveProperty('temperature', 1);
  });

  it('retries an empty, length-truncated answer once with a larger budget and remembers the raised floor', async () => {
    const create = jest.fn().mockResolvedValueOnce(emptyLength).mockResolvedValue(ok);
    const client = makeClient(create);

    const first = await client.chat(user, { model: 'OpenAI/gpt-5-mini', maxTokens: 50 });
    await client.chat(user, { model: 'OpenAI/gpt-5-mini', maxTokens: 50 });

    expect(first.content).toBe('ok');
    expect(create.mock.calls[0][0]).toHaveProperty('max_tokens', 50);
    expect(create.mock.calls[1][0]).toHaveProperty('max_tokens', 4000);
    expect(create.mock.calls[2][0]).toHaveProperty('max_tokens', 4000);
  });

  it('returns a second empty answer as it is instead of looping', async () => {
    const create = jest.fn().mockResolvedValue(emptyLength);
    const client = makeClient(create);

    const result = await client.chat(user, { model: 'OpenAI/gpt-5-nano', maxTokens: 50 });

    expect(result.content).toBe('');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry an empty answer that was not cut off by the limit, nor one that carries tool calls', async () => {
    const create = jest
      .fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '', tool_calls: [{ id: '1' }] }, finish_reason: 'length' }] });
    const client = makeClient(create);

    await client.chat(user, { model: 'm', maxTokens: 50 });
    await client.chat(user, { model: 'm', maxTokens: 50 });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('retries an empty vision caption once with a larger budget', async () => {
    const create = jest.fn().mockResolvedValueOnce(emptyLength).mockResolvedValue({ choices: [{ message: { content: 'a caption' }, finish_reason: 'stop' }] });
    const client = makeClient(create);

    const text = await client.vision('describe', [Buffer.from('img')], { model: 'OpenAI/gpt-5-nano' });

    expect(text).toBe('a caption');
    expect(create.mock.calls[0][0]).toHaveProperty('max_tokens', 300);
    expect(create.mock.calls[1][0]).toHaveProperty('max_tokens', 4000);
  });

  it('vision() uses max_completion_tokens once chat() has learned the model needs it', async () => {
    const create = jest.fn().mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS)).mockResolvedValue(ok);
    const client = makeClient(create);

    await client.chat(user, { model: 'gpt-chat-latest', maxTokens: 100 });
    await client.vision('describe', [Buffer.from('img')], { model: 'gpt-chat-latest' });

    expect(create.mock.calls[2][0]).toHaveProperty('max_completion_tokens', 300);
    expect(create.mock.calls[2][0]).not.toHaveProperty('max_tokens');
  });

  it('streamChat() switches the token parameter the same way', async () => {
    async function* stream() {
      yield { choices: [{ delta: { content: 'ok' } }] };
    }
    const create = jest.fn().mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS)).mockResolvedValueOnce(stream());
    const client = makeClient(create);

    const chunks: string[] = [];
    for await (const chunk of client.streamChat(user, { model: 'gpt-chat-latest', maxTokens: 100 })) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks).toEqual(['ok']);
    expect(create.mock.calls[1][0]).toHaveProperty('max_completion_tokens', 100);
  });

  it('sends no output limit when the proxy turns max_completion_tokens back into max_tokens (gpt-chat-latest on Elbichat)', async () => {
    // Observed in prod: after the switch the request still reached Azure with max_tokens, because LiteLLM does not
    // recognise the alias as a reasoning model and maps the parameter back.
    const create = jest
      .fn()
      .mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS))
      .mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS))
      .mockResolvedValue(ok);
    const client = makeClient(create);

    const result = await client.chat(user, { model: 'OpenAI/gpt-chat-latest', maxTokens: 20000, responseSchema: { name: 's', schema: { type: 'object' } } });

    expect(result.content).toBe('ok');
    expect(create.mock.calls[0][0]).toHaveProperty('max_tokens', 20000);
    expect(create.mock.calls[1][0]).toHaveProperty('max_completion_tokens', 20000);
    expect(create.mock.calls[2][0]).not.toHaveProperty('max_tokens');
    expect(create.mock.calls[2][0]).not.toHaveProperty('max_completion_tokens');
    // A token-limit refusal is not a schema problem: the schema stays.
    expect(create.mock.calls[2][0]).toHaveProperty('response_format');
  });

  it('remembers that for the model: the next call never sends a limit and costs one request', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS))
      .mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS))
      .mockResolvedValue(ok);
    const client = makeClient(create);

    await client.chat(user, { model: 'OpenAI/gpt-chat-latest', maxTokens: 100 });
    await client.chat(user, { model: 'OpenAI/gpt-chat-latest', maxTokens: 100 });
    await client.vision('describe', [Buffer.from('img')], { model: 'OpenAI/gpt-chat-latest' });

    expect(create).toHaveBeenCalledTimes(5);
    for (const call of create.mock.calls.slice(2)) {
      expect(call[0]).not.toHaveProperty('max_tokens');
      expect(call[0]).not.toHaveProperty('max_completion_tokens');
    }
  });

  it('streamChat() sends no limit either once the model has refused both', async () => {
    async function* stream() {
      yield { choices: [{ delta: { content: 'ok' } }] };
    }
    const create = jest
      .fn()
      .mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS))
      .mockRejectedValueOnce(apiError(AZURE_MAX_TOKENS))
      .mockResolvedValueOnce(stream());
    const client = makeClient(create);

    const chunks: string[] = [];
    for await (const chunk of client.streamChat(user, { model: 'OpenAI/gpt-chat-latest', maxTokens: 100 })) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks).toEqual(['ok']);
    expect(create.mock.calls[2][0]).not.toHaveProperty('max_tokens');
    expect(create.mock.calls[2][0]).not.toHaveProperty('max_completion_tokens');
  });

  it('keeps the attempt cap: a model that keeps failing ends as an upstream error, not an endless loop', async () => {
    const create = jest.fn().mockRejectedValue(apiError(AZURE_MAX_TOKENS));
    const client = makeClient(create);

    await expect(client.chat(user, { model: 'm', maxTokens: 100 })).rejects.toMatchObject({ name: 'UpstreamHttpError', upstreamStatus: 400 });
    expect(create.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe('OpenWebUiClient.showModel via LiteLLM model info', () => {
  const config = {
    LLM_BASE_URL: 'https://proxy.example/v1',
    LLM_API_KEY: 'sk-user-token',
    LLM_CHAT_MODEL: 'claude-opus-4-8',
    LLM_TRUSTED_LOCAL: false,
    EMBED_TRANSPORT: 'openai' as const,
    EMBED_BASE_URL: undefined,
    EMBED_MODEL: 'text-embedding-3-small',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 600_000,
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
  };
  const response = (ok: boolean, status: number, body: unknown = {}) => ({ ok, status, json: async () => body });
  const litellmBody = {
    data: [
      {
        model_name: 'OpenAI/gpt-5.4',
        model_info: {
          max_input_tokens: 922000,
          max_output_tokens: 128000,
          supports_vision: true,
          supports_function_calling: true,
          supports_reasoning: true,
          supports_response_schema: true,
        },
      },
      { model_name: 'gpt-chat-latest', model_info: {} },
    ],
  };

  // Ollama's native /api/show does not exist on the proxy; LiteLLM's model info does.
  const proxyFetch = (modelInfoStatus = 200, body: unknown = litellmBody) =>
    jest.fn(async (url: string) => {
      if (String(url).endsWith('/api/show')) return response(false, 404);
      if (String(url).endsWith('/v1/model/info')) return modelInfoStatus === 200 ? response(true, 200, body) : response(false, modelInfoStatus);
      return response(false, 404);
    });

  it('reads context, output ceiling and capabilities from the proxy', async () => {
    global.fetch = proxyFetch() as any;

    const info = await new OpenWebUiClient(config).showModel('OpenAI/gpt-5.4');

    expect(info).toEqual({
      contextLength: 922000,
      capabilities: ['vision', 'tools', 'reasoning', 'structured_output'],
      maxOutputTokens: 128000,
      source: 'litellm',
    });
  });

  it('sends the user token and asks /v1/model/info, then /model/info on a 404', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).endsWith('/v1/model/info')) return response(false, 404);
      if (String(url).endsWith('/model/info')) return response(true, 200, litellmBody);
      return response(false, 404);
    });
    global.fetch = fetchMock as any;

    const info = await new OpenWebUiClient(config).showModel('OpenAI/gpt-5.4');

    expect(info.contextLength).toBe(922000);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(expect.arrayContaining(['https://proxy.example/v1/model/info', 'https://proxy.example/model/info']));
    const liteCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/model/info')) as unknown as [string, RequestInit];
    expect((liteCall[1].headers as Record<string, string>).Authorization).toBe('Bearer sk-user-token');
  });

  it('matches the model name case-insensitively', async () => {
    global.fetch = proxyFetch() as any;

    const info = await new OpenWebUiClient(config).showModel('openai/GPT-5.4');

    expect(info.maxOutputTokens).toBe(128000);
  });

  it('treats an alias the proxy lists without any limits as "states nothing" (unknown, never zero)', async () => {
    global.fetch = proxyFetch() as any;

    const info = await new OpenWebUiClient(config).showModel('gpt-chat-latest');

    expect(info).toMatchObject({ contextLength: null, capabilities: [], source: 'litellm' });
  });

  it('reports a model nobody lists as ModelInfoUnavailableError', async () => {
    global.fetch = proxyFetch() as any;

    await expect(new OpenWebUiClient(config).showModel('condor_x')).rejects.toBeInstanceOf(ModelInfoUnavailableError);
  });

  it('reports a rejected token as unavailable with the status, rather than an empty answer', async () => {
    global.fetch = proxyFetch(401) as any;

    await expect(new OpenWebUiClient(config).showModel('OpenAI/gpt-5.4')).rejects.toThrow(/401/);
  });

  it('treats an HTML page answered for an unknown path (Open WebUI) as "no such route", not as a failure', async () => {
    const html = { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    global.fetch = jest.fn(async (url: string) => (String(url).endsWith('/api/show') ? response(false, 404) : html)) as any;

    const error = await new OpenWebUiClient(config).showModel('OpenAI/gpt-5.4').catch((e) => e);

    expect(error).toBeInstanceOf(ModelInfoUnavailableError);
    expect(String(error.message)).not.toMatch(/Unexpected token/);
  });

  it('caches the answer: a second lookup makes no requests', async () => {
    const fetchMock = proxyFetch();
    global.fetch = fetchMock as any;
    const client = new OpenWebUiClient(config);

    await client.showModel('OpenAI/gpt-5.4');
    const before = fetchMock.mock.calls.length;
    await client.showModel('OpenAI/gpt-5.4');

    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe('model visibility (LLM_MODEL_HIDE_PATTERNS)', () => {
  const patterns = parseModelHidePatterns(
    'condor_*, data-frames, fai-checker, azure_ai/mistral-document-ai, ins-sw, contracts-ai-*, find-a-material-*, *-coc--atr, *gpt-5-chat*',
  );

  it('hides the listed names, case-insensitively and by whole name', () => {
    for (const name of ['condor_x', 'Condor_Y', 'data-frames', 'FAI-checker', 'azure_ai/mistral-document-ai', 'contracts-ai-poc', 'find-a-material-v2', 'x-coc--atr', 'OpenAI/gpt-5-chat']) {
      expect(isModelHidden(name, patterns)).toBe(true);
    }
  });

  it('keeps real models visible, including ones that only share a prefix or substring', () => {
    for (const name of ['claude-opus-4-8', 'OpenAI/gpt-5.4', 'OpenAI/gpt-chat-latest', 'OpenAI/gpt-5.4-mini', 'data-frames-extra', 'my-fai-checker']) {
      expect(isModelHidden(name, patterns)).toBe(false);
    }
  });

  it('treats regex characters in a pattern literally and an empty list as "hide nothing"', () => {
    expect(isModelHidden('a.b', parseModelHidePatterns('a.b'))).toBe(true);
    expect(isModelHidden('axb', parseModelHidePatterns('a.b'))).toBe(false);
    expect(parseModelHidePatterns(undefined)).toEqual([]);
    expect(parseModelHidePatterns(' , ,')).toEqual([]);
    expect(isModelHidden('anything', [])).toBe(false);
  });

  const config = {
    LLM_BASE_URL: 'https://proxy.example/v1',
    LLM_API_KEY: 'sk-user-token',
    LLM_CHAT_MODEL: 'claude-opus-4-8',
    LLM_TRUSTED_LOCAL: false,
    EMBED_TRANSPORT: 'openai' as const,
    EMBED_BASE_URL: undefined,
    EMBED_MODEL: 'text-embedding-3-small',
    EMBED_PATH: '/api/embed',
    SHOW_PATH: '/api/show',
    FILES_UPLOAD_PATH: '/api/v1/files/',
    FILES_STATUS_PATH: '/api/v1/files',
    LLM_REQUEST_TIMEOUT_MS: 600_000,
    LLM_SEND_SEED: false,
    LLM_SEND_REASONING_EFFORT: false,
    LLM_MODEL_HIDE_PATTERNS: 'condor_*,contracts-ai-*',
  };

  it('listModels() leaves hidden models out', async () => {
    const client = new OpenWebUiClient(config as any);
    // @ts-expect-error -- reaching into the private SDK client for a test double
    client.openai.models.list = jest.fn().mockResolvedValue({ data: [{ id: 'claude-opus-4-8' }, { id: 'condor_a' }, { id: 'contracts-ai-x' }] });

    expect(await client.listModels()).toEqual(['claude-opus-4-8']);
  });

  it('listSelectableModels() leaves hidden models out', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }, { id: 'condor_a' }, { id: 'OpenAI/gpt-5.4', name: 'GPT 5.4' }] }),
    }) as any;

    const models = await new OpenWebUiClient(config as any).listSelectableModels();

    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'OpenAI/gpt-5.4']);
  });
});
