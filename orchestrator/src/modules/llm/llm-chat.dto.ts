import { z } from 'zod';

export const llmChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
      }),
    )
    .min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export type LlmChatRequestBody = z.infer<typeof llmChatRequestSchema>;
