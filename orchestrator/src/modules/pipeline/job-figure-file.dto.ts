import { z } from 'zod';

export const jobFigureFileUploadSchema = z.object({
  // base64-encoded, already-compressed image bytes -- compression happens
  // ingestion-side (see _describe_figure_with_progress); this endpoint just
  // persists whatever it's given.
  bytes: z.string().min(1),
  mimeType: z.string().min(1),
});

export type JobFigureFileUploadBody = z.infer<typeof jobFigureFileUploadSchema>;
