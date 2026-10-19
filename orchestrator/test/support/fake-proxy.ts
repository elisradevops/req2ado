import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { capabilitiesFor } from '../../src/modules/llm/model-capabilities';

// A fake of the LLM proxy as the app sees it (Open WebUI in front of LiteLLM in front of Azure/Anthropic): a real HTTP
// server, so the client under test runs its real fetch/SDK path. What each model refuses, and the exact error texts, come
// from the prod reports (model compatibility probes of 12 to 19 Oct) and the captured Open WebUI objects; a behaviour is
// data, so a new model family is one more entry. Success answers use status 201, as the deployment does.

export interface ProxyBehavior {
  /** Which output-limit parameter the model takes; `neither` is the proxy turning one into the other (both refused). */
  tokenParam: 'max_tokens' | 'max_completion_tokens' | 'neither';
  /** `fixed-1`: only the default value is accepted (Claude 4.x via LiteLLM, GPT-5.x reasoning). */
  temperature: 'any' | 'fixed-1';
  temperatureWording?: 'litellm-unsupported-params' | 'azure-unsupported-value';
  /** The model's output ceiling, refused above it. */
  maxOutput?: number;
  /** Input plus output must fit in this many tokens (gpt-oss counts output inside its window). */
  contextWindow?: number;
  /** A response_format schema answers 400 with no body (what Claude does with some schemas). */
  schema: 'ok' | 'reject-without-body';
  /** Function tools answer 400 unless `reasoning_effort: 'none'` (GPT-5.6 on Chat Completions). */
  toolsNeedReasoningNone?: boolean;
  /** Answers 429 with this retry hint for the first N calls. */
  rateLimitedCalls?: { count: number; retryAfterSeconds: number };
  /** The text of a successful answer. */
  answer?: string;
}

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, any>;
}

export interface FakeProxy {
  /** `http://127.0.0.1:<port>`; the OpenAI-compatible base URL is `${url}/v1`. */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export const BEHAVIORS = {
  claudeOpus: { tokenParam: 'max_tokens', temperature: 'fixed-1', temperatureWording: 'litellm-unsupported-params', maxOutput: 128_000, schema: 'ok' },
  claudeSonnetSchemaFlaky: { tokenParam: 'max_tokens', temperature: 'fixed-1', temperatureWording: 'litellm-unsupported-params', maxOutput: 64_000, schema: 'reject-without-body' },
  gpt56Reasoning: { tokenParam: 'max_completion_tokens', temperature: 'fixed-1', temperatureWording: 'azure-unsupported-value', maxOutput: 128_000, schema: 'ok', toolsNeedReasoningNone: true },
  gptChatLatestProxyConverts: { tokenParam: 'neither', temperature: 'any', schema: 'ok' },
  gptOss: { tokenParam: 'max_completion_tokens', temperature: 'any', contextWindow: 131_072, schema: 'ok' },
} satisfies Record<string, ProxyBehavior>;

const chars = (messages: { content?: unknown }[]): number => messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

function refusal(body: Record<string, any>, behavior: ProxyBehavior, model: string): { status: number; text: string } | null {
  if (behavior.tokenParam === 'neither' && ('max_tokens' in body || 'max_completion_tokens' in body)) {
    return { status: 400, text: "litellm.UnsupportedParamsError: azure does not support parameters: ['max_tokens']" };
  }
  if (behavior.tokenParam === 'max_completion_tokens' && 'max_tokens' in body) {
    return { status: 400, text: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." };
  }
  if (behavior.tokenParam === 'max_tokens' && 'max_completion_tokens' in body) {
    return { status: 400, text: "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead." };
  }
  if (behavior.temperature === 'fixed-1' && typeof body.temperature === 'number' && body.temperature !== 1) {
    return {
      status: 400,
      text:
        behavior.temperatureWording === 'azure-unsupported-value'
          ? "litellm.BadRequestError: AzureException BadRequestError - Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported."
          : `litellm.UnsupportedParamsError: ${model} does not support temperature=${body.temperature}. Only temperature=1 is supported.`,
    };
  }
  const requested = body.max_tokens ?? body.max_completion_tokens;
  if (typeof requested === 'number' && behavior.maxOutput && requested > behavior.maxOutput) {
    return { status: 400, text: `max_tokens is too large: ${requested}. This model supports at most ${behavior.maxOutput} completion tokens, whereas you provided ${requested}.` };
  }
  if (typeof requested === 'number' && behavior.contextWindow) {
    const input = Math.ceil(chars(body.messages ?? []) / 4) + 70; // a stable stand-in for the proxy's own token count
    if (input + requested > behavior.contextWindow) {
      return {
        status: 400,
        text: `litellm.BadRequestError: AzureException - Requested token count exceeds the model's maximum context length of ${behavior.contextWindow} tokens. You requested a total of ${input + requested} tokens: ${input} tokens from the input messages and ${requested} tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.`,
      };
    }
  }
  if (behavior.toolsNeedReasoningNone && Array.isArray(body.tools) && body.reasoning_effort !== 'none') {
    return { status: 400, text: "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." };
  }
  if (behavior.schema === 'reject-without-body' && body.response_format?.type === 'json_schema') {
    return { status: 400, text: '' };
  }
  return null;
}

function readBody(request: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export async function startFakeProxy(models: Record<string, ProxyBehavior>): Promise<FakeProxy> {
  const requests: RecordedRequest[] = [];
  const calls: Record<string, number> = {};
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    const path = (request.url ?? '').split('?')[0];
    requests.push({ path, headers: request.headers, body });
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(payload));
    };
    if (request.method === 'GET' && path === '/api/models') {
      return json(200, { data: Object.keys(models).map((id) => ({ id, name: id, info: { meta: { capabilities: { vision: true } } } })) });
    }
    if (request.method === 'POST' && (path === '/v1/chat/completions' || path === '/api/chat/completions')) {
      const model = String(body.model ?? '');
      const behavior = models[model];
      if (!behavior) return json(404, { detail: 'Model not found' });
      calls[model] = (calls[model] ?? 0) + 1;
      if (behavior.rateLimitedCalls && calls[model] <= behavior.rateLimitedCalls.count) {
        return json(429, { error: { message: 'rate limited', type: 'rate_limit_error' } }, { 'retry-after': String(behavior.rateLimitedCalls.retryAfterSeconds) });
      }
      const refused = refusal(body, behavior, model);
      if (refused) {
        response.writeHead(refused.status, refused.text ? { 'Content-Type': 'application/json' } : {});
        return response.end(refused.text ? JSON.stringify({ error: { message: refused.text, type: 'invalid_request_error' } }) : '');
      }
      const content = behavior.answer ?? 'OK';
      if (body.stream === true) {
        response.writeHead(201, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.write('data: [DONE]\n\n');
        return response.end();
      }
      return json(201, {
        id: 'chatcmpl-fake', object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }
    return json(404, { detail: 'Not Found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The proxy behaviour the capability table describes for a model, or null for a model the table does not know. */
export function behaviorFromCapabilities(model: string): ProxyBehavior | null {
  const capability = capabilitiesFor(model);
  if (!capability) return null;
  return {
    tokenParam: capability.tokenParam === 'none' ? 'neither' : capability.tokenParam,
    temperature: capability.temperature.mode === 'fixed' ? 'fixed-1' : 'any',
    temperatureWording: capability.family.startsWith('claude') ? 'litellm-unsupported-params' : 'azure-unsupported-value',
    ...(capability.outputCountsInContext && capability.contextTokens ? { contextWindow: capability.contextTokens } : {}),
    toolsNeedReasoningNone: Boolean(capability.toolsRequireReasoningNoneFor && new RegExp(capability.toolsRequireReasoningNoneFor, 'i').test(model)),
    schema: 'ok',
  };
}
