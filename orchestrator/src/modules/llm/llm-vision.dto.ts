import { z } from 'zod';

export const llmVisionRequestSchema = z.object({
  prompt: z.string().min(1),
  // base64-encoded image bytes, one entry per image.
  images: z.array(z.string().min(1)).min(1),
  model: z.string().optional(),
});

export type LlmVisionRequestBody = z.infer<typeof llmVisionRequestSchema>;
