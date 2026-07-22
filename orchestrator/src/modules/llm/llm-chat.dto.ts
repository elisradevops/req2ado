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
    content: z.string().optional(),
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
  responseSchema: z
    .object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      schema: z.record(z.unknown()),
    })
    .optional(),
  maxTokens: z.number().int().positive().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  toolChoice: z.union([z.literal('auto'), z.literal('none'), z.literal('required')]).optional(),
});

export type LlmChatRequestBody = z.infer<typeof llmChatRequestSchema>;
