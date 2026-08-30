import { z } from 'zod';

// Query params arrive as strings -- coerced explicitly, same convention as
// eta-estimate.dto.ts's etaEstimateQuerySchema. Both optional: GET /jobs
// with no query string at all (today's only real caller, the frontend job
// list) must keep returning every retained job, unchanged.
export const jobsListQuerySchema = z.object({
  skip: z.coerce.number().int().min(0).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});

export type JobsListQuery = z.infer<typeof jobsListQuerySchema>;
