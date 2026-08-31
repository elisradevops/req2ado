import { z } from 'zod';

export const llmConnectionRequestSchema = z.object({
  apiKey: z.string().min(1),
  chatModel: z.string().min(1),
  // Omitted means the chat model is itself vision-capable and serves both
  // roles -- see LlmConnectionController's own doc comment for the full
  // resolution rule.
  visionModel: z.string().min(1).optional(),
});

export type LlmConnectionRequestBody = z.infer<typeof llmConnectionRequestSchema>;
