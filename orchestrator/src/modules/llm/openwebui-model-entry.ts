import { z } from 'zod';

// The shape of one model as Open WebUI lists it (`GET /api/models`, also embedded as `model_item` in the chat
// requests its web client sends). Open WebUI fills it from the connection (here a LiteLLM proxy), from the
// administrator's saved settings and from its own defaults, so the same field can be a fact or a default:
//   - `max_input_tokens` / `max_output_tokens` / `mode` come from the connection when it knows the model (the Claude
//     entries do, the GPT and gpt-oss entries do not);
//   - `info.meta.capabilities.*` are Open WebUI feature switches, set to true on every model (gpt-oss-120b says it
//     has vision), so they are a claim, not a measurement;
//   - `ollama.capabilities` (a string array) exists only for Ollama connections and is a real report.
// Unknown fields are kept (passthrough): the proxy adds fields over time and a new one must never break parsing.

const limit = z.unknown();

const connectionObject = z
  .object({
    id: z.string().optional(),
    mode: z.string().optional(),
    max_input_tokens: limit.optional(),
    max_output_tokens: limit.optional(),
    connection_type: z.string().optional(),
  })
  .passthrough();

export const openWebUiModelEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    object: z.string().optional(),
    owned_by: z.string().optional(),
    preset: z.boolean().optional(),
    mode: z.string().optional(),
    max_input_tokens: limit.optional(),
    max_output_tokens: limit.optional(),
    connection_type: z.string().optional(),
    openai: connectionObject.optional(),
    ollama: z.object({ capabilities: z.array(z.string()).optional() }).passthrough().optional(),
    info: z
      .object({
        base_model_id: z.string().nullable().optional(),
        is_active: z.boolean().optional(),
        meta: z
          .object({
            description: z.string().nullable().optional(),
            capabilities: z.record(z.unknown()).optional(),
            tags: z.array(z.object({ name: z.string() }).passthrough()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    tags: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export type OpenWebUiModelEntry = z.infer<typeof openWebUiModelEntrySchema>;

// The request Open WebUI's own web client posts to its native `/api/chat/completions`. Sampling settings are NOT in
// it (`params` is empty): the model's own defaults apply, which is why a chat works on every model while a call with
// `temperature: 0` can be refused. Used by mocks of that route.
export const openWebUiChatRequestSchema = z
  .object({
    stream: z.boolean(),
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.string(), content: z.unknown().optional(), output: z.unknown().optional() }).passthrough()).min(1),
    params: z.record(z.unknown()),
    tool_servers: z.array(z.unknown()).optional(),
    features: z.record(z.boolean()).optional(),
    variables: z.record(z.string()).optional(),
    model_item: openWebUiModelEntrySchema,
    session_id: z.string().optional(),
    chat_id: z.string().optional(),
    id: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    parent_message: z.record(z.unknown()).optional(),
    background_tasks: z.record(z.boolean()).optional(),
  })
  .passthrough();

export type OpenWebUiChatRequest = z.infer<typeof openWebUiChatRequestSchema>;

/** What the app decides on from a model entry. `null` means the entry does not state it, never zero. */
export interface ModelFacts {
  id: string;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  vision: boolean;
}

// Families whose real behaviour contradicts the entry's flags, verified by the compatibility probe against the proxy.
const NO_VISION_FAMILIES: readonly RegExp[] = [/gpt-oss/i];

const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

export function modelFactsFromEntry(entry: OpenWebUiModelEntry): ModelFacts {
  const flag = entry.info?.meta?.capabilities?.vision === true;
  let vision: boolean;
  if (entry.ollama?.capabilities) vision = entry.ollama.capabilities.includes('vision');
  else if (NO_VISION_FAMILIES.some((pattern) => pattern.test(entry.id))) vision = false;
  else vision = flag;
  return {
    id: entry.id,
    contextTokens: positive(entry.max_input_tokens) ?? positive(entry.openai?.max_input_tokens),
    maxOutputTokens: positive(entry.max_output_tokens) ?? positive(entry.openai?.max_output_tokens),
    vision,
  };
}
