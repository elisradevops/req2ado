import { z } from 'zod';

// Widened for tool-calling (§5a of the SURVEY holistic-analysis redesign):
// an assistant message that ISSUES tool calls carries `tool_calls` and often
// empty/absent `content`; a `tool` message carries `tool_call_id` + the
// executed tool's result as `content`. `content` stays required for the
// original plain system/user/assistant turns (existing single-shot callers
// are unaffected) but is optional when `tool_calls` is present.
const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    // A string, or the same text as parts, one of which may mark the end of a stable prefix (a prompt-cache breakpoint).
    content: z
      .union([
        z.string(),
        z.array(z.object({ type: z.literal('text'), text: z.string(), cache_control: z.object({ type: z.literal('ephemeral') }).optional() }).strict()).min(1),
      ])
      .optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal('function'),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .optional(),
    tool_call_id: z.string().optional(),
  })
  .refine((m) => (m.content !== undefined && m.content.length > 0) || (m.tool_calls?.length ?? 0) > 0, {
    message: 'content (non-empty) or tool_calls (non-empty) is required',
  });

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.unknown()),
  }),
});

export const llmChatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  // Real gap this closes: openwebui.client.ts's own request builder already
  // spreads a `seed` into the Ollama payload when given one, but nothing in
  // this DTO ever carried one from a caller -- so a seed sent from
  // ingestion's LLM client was silently dropped before it ever reached
  // openwebui.client.ts, and every call site ran on the backend's default
  // (non-deterministic) seed regardless of temperature=0.
  seed: z.number().int().optional(),
  responseSchema: z
    .object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      schema: z.record(z.unknown()),
      strict: z.boolean().optional(),
    })
    .optional(),
  maxTokens: z.number().int().positive().optional(),
  // Ollama's actual runtime context window (distinct from a model's
  // architectural max) -- unset, Ollama truncates to its own small default
  // regardless of how large a prompt this proxies. Only meaningful for
  // local/dev models; the production frontier-model proxy manages context
  // server-side and ignores this (see openwebui.client.ts's forwarding).
  numCtx: z.number().int().positive().optional(),
  // Gemma4 repetition-collapse mitigation (see llm-client.interface.ts's
  // LlmChatOptions.topK/minP doc comment for the confirmed upstream bug and
  // why repeat_penalty doesn't work as a substitute).
  topK: z.number().int().positive().optional(),
  minP: z.number().min(0).max(1).optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  toolChoice: z.union([z.literal('auto'), z.literal('none'), z.literal('required')]).optional(),
  // See LlmChatOptions.think's own doc comment (llm-client.interface.ts) --
  // explicit `false` disables a reasoning model's hidden chain-of-thought.
  think: z.boolean().optional(),
  promptCache: z.boolean().optional(),
  budgetKind: z.literal('study').optional(),
  // An Open WebUI file the orchestrator uploaded for this study call (see LlmChatOptions.fileId). Ids are opaque tokens; anything else is refused.
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  // How long the caller will wait for this call, retries included (ms).
  deadlineMs: z.number().int().positive().optional(),
  // Job transparency (B7): /llm/chat/stream only. When true, the stream ends
  // with one terminal line `{done, finishReason, model}` so a caller can tell
  // a finished answer from a cut-off one and see why the model stopped. Off by
  // default: every existing caller keeps the exact stream it always got.
  includeDone: z.boolean().optional(),
});

export type LlmChatRequestBody = z.infer<typeof llmChatRequestSchema>;
