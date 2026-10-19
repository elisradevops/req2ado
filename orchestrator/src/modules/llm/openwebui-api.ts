import { z } from 'zod';
import { openWebUiModelEntrySchema, type OpenWebUiModelEntry } from './openwebui-model-entry';

// What the app accepts from, and sends to, the Open WebUI routes it uses, written from the Open WebUI API reference
// (`/api/chat/completions`, `/api/models`, `/api/chat/completed`) and from errors seen in prod. Every object keeps
// unknown fields (passthrough): the proxy adds fields over time (usage totals, `sources`, reasoning text) and a new
// one must never turn a good answer into a failure.

const toolCall = z
  .object({ id: z.string().optional(), type: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).passthrough().optional() })
  .passthrough();

// Open WebUI reports the last call's `prompt_tokens`/`completion_tokens` and the whole reply's
// `input_tokens`/`output_tokens`/`total_tokens`.
const usage = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

/** Non-streaming `POST /api/chat/completions` answer: an OpenAI chat completion, plus `usage` extras and `sources`. */
export const chatCompletionResponseSchema = z
  .object({
    id: z.string().optional(),
    object: z.string().optional(),
    created: z.number().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            index: z.number().optional(),
            message: z
              .object({
                role: z.string().optional(),
                content: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                tool_calls: z.array(toolCall).optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: usage.optional(),
    sources: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;

/** One server-sent chunk of a streamed answer. The last chunk can carry only `usage`, with an empty `choices`. */
export const chatCompletionChunkSchema = z
  .object({
    choices: z.array(
      z
        .object({
          index: z.number().optional(),
          delta: z
            .object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), tool_calls: z.array(toolCall).optional() })
            .passthrough()
            .optional(),
          finish_reason: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
    usage: usage.optional(),
  })
  .passthrough();

export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;

/** `GET /api/models`: `{ data: [entry] }`. An entry that does not parse is dropped, the others are kept. */
export const modelsResponseSchema = z.object({
  data: z.array(z.unknown()).transform((raw): OpenWebUiModelEntry[] =>
    raw.flatMap((item) => {
      const parsed = openWebUiModelEntrySchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
});

// ---- Request body of `POST /api/chat/completions` (and the OpenAI-compatible `<LLM_BASE_URL>/chat/completions`) ----
// The full set of fields the route accepts: OpenAI Chat Completions parameters, the Open WebUI additions
// (`files`, `chat_id`/`id`/`session_id`/`parent_id`, `features`, `variables`, `params`, `tool_servers`,
// `background_tasks`, `model_item`) and Ollama's `options`. Strict on purpose: a field this list does not know is
// either a typo in our own request or a new field of the route, and both should fail a contract test, not go unseen.
// The fields THIS app sends are listed in APP_REQUEST_KEYS; the others exist for mocks of the web client.

const textPart = z.object({ type: z.literal('text'), text: z.string() }).strict();
const imagePart = z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string(), detail: z.enum(['low', 'high', 'auto']).optional() }).strict() }).strict();
const contentPart = z.union([textPart, imagePart]);

const requestMessage = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(contentPart), z.null()]).optional(),
    name: z.string().optional(),
    tool_calls: z.array(toolCall).optional(),
    tool_call_id: z.string().optional(),
    // Added by the web client on assistant turns (Responses-style output items); ignored by the route.
    output: z.unknown().optional(),
  })
  .strict();

const responseFormat = z.union([
  z.object({ type: z.literal('text') }).strict(),
  z.object({ type: z.literal('json_object') }).strict(),
  z
    .object({
      type: z.literal('json_schema'),
      json_schema: z.object({ name: z.string().min(1), strict: z.boolean().optional(), schema: z.record(z.unknown()), description: z.string().optional() }).strict(),
    })
    .strict(),
]);

const fileReference = z.object({ type: z.enum(['file', 'collection']), id: z.string().min(1), context: z.literal('full').optional() }).strict();

export const openWebUiCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(requestMessage).min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
    // Sampling and limits (which of them a model accepts is the capability table's business, not the schema's).
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    seed: z.number().int().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    logit_bias: z.record(z.number()).optional(),
    reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    response_format: responseFormat.optional(),
    tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string(), description: z.string().optional(), parameters: z.record(z.unknown()).optional() }).strict() }).strict()).optional(),
    tool_choice: z.union([z.enum(['none', 'auto', 'required']), z.record(z.unknown())]).optional(),
    // Ollama's own options (`num_ctx`, ...): only a trusted-local deployment understands them.
    options: z.record(z.unknown()).optional(),
    // Open WebUI additions.
    files: z.array(fileReference).optional(),
    chat_id: z.string().optional(),
    id: z.string().optional(),
    session_id: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    parent_message: z.record(z.unknown()).optional(),
    params: z.record(z.unknown()).optional(),
    features: z.record(z.boolean()).optional(),
    variables: z.record(z.string()).optional(),
    tool_servers: z.array(z.unknown()).optional(),
    background_tasks: z.record(z.boolean()).optional(),
    model_item: openWebUiModelEntrySchema.optional(),
  })
  .strict();

export type OpenWebUiCompletionRequest = z.infer<typeof openWebUiCompletionRequestSchema>;

/** The request fields this app sends (the rest of the schema documents the route for the web client and for mocks). */
export const APP_REQUEST_KEYS: readonly (keyof OpenWebUiCompletionRequest)[] = [
  'model', 'messages', 'stream', 'stream_options', 'temperature', 'seed', 'max_tokens', 'max_completion_tokens',
  'reasoning_effort', 'frequency_penalty', 'response_format', 'files', 'options',
];

/**
 * `POST /api/chat/completed`: runs the deployment's outlet filters over a finished conversation. Only a caller that
 * needs those filters' output has to call it; this app does not (it reads the answer from `/api/chat/completions`
 * and sends no `chat_id`, so nothing is stored in a chat). The body needs the whole conversation including the
 * assistant reply, the assistant message id, and `chat_id`/`session_id` keys that may be empty strings.
 */
export const chatCompletedRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()).min(1),
  id: z.string().min(1),
  chat_id: z.string(),
  session_id: z.string(),
});

export type ChatCompletedRequest = z.infer<typeof chatCompletedRequestSchema>;

/**
 * The message inside an error body. Open WebUI answers `{"detail": "..."}` (FastAPI), the providers behind it answer
 * `{"error": {"message": "..."}}` or `{"error": "..."}`; anything else is returned as it is.
 */
export function errorMessageFromBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { detail?: unknown; error?: unknown; message?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object' && typeof (parsed.error as { message?: unknown }).message === 'string') {
      return (parsed.error as { message: string }).message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    /* not JSON: the text itself is the message */
  }
  return trimmed;
}

/** How long the provider asked to wait (a 429 passes `retry-after-ms` and `retry-after` through), or null. */
export function retryAfterMsFromHeaders(headers: Record<string, string | null | undefined>, now: number = Date.now()): number | null {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const ms = Number(lower['retry-after-ms']);
  if (lower['retry-after-ms'] && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = lower['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
