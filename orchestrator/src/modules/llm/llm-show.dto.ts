import { z } from 'zod';

export const llmShowRequestSchema = z.object({
  model: z.string().min(1),
});

export type LlmShowRequestBody = z.infer<typeof llmShowRequestSchema>;
