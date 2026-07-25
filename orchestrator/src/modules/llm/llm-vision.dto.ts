import { z } from 'zod';

export const llmVisionRequestSchema = z.object({
  prompt: z.string().min(1),
  // base64-encoded image bytes, one entry per image.
  images: z.array(z.string().min(1)).min(1),
  model: z.string().optional(),
  // Real content-type of the image bytes above (e.g. 'image/jpeg',
  // 'image/gif') -- every image in one call shares the same mime type,
  // matching describe_figure's existing one-image-per-call convention.
  // Omitted (the pre-existing default) falls back to 'image/png', which was
  // previously hardcoded regardless of actual content -- harmless for a PNG
  // and for docx-embedded figures whose real type was never surfaced, but
  // wrong for a directly-uploaded non-PNG image (KB image ingestion).
  mimeType: z.string().optional(),
});

export type LlmVisionRequestBody = z.infer<typeof llmVisionRequestSchema>;
