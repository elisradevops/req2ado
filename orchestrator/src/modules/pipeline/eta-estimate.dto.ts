import { z } from 'zod';

// Query params arrive as strings -- coerced explicitly rather than trusting
// JS truthiness/parseInt on an uncoerced value, which would silently
// propagate string-concatenation garbage into the ETA arithmetic instead of
// a real validation error (DESIGN.md §11.2.3.d).
export const etaEstimateQuerySchema = z.object({
  blockCount: z.coerce.number().int().min(0),
  figureCount: z.coerce.number().int().min(0),
  mode: z.enum(['baseline', 'survey']),
  model: z.string().optional(),
  // The document's size in tokens (the preview returns it): lets the answer include a forecast of what a SURVEY run will spend.
  documentTokens: z.coerce.number().int().min(0).optional(),
});

export type EtaEstimateQuery = z.infer<typeof etaEstimateQuerySchema>;
