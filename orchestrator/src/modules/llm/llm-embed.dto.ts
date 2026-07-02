import { z } from 'zod';

export const llmEmbedRequestSchema = z.object({
  texts: z.array(z.string().min(1)).min(1),
});

export type LlmEmbedRequestBody = z.infer<typeof llmEmbedRequestSchema>;
