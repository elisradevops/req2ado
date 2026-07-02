import { z } from 'zod';

export const loginRequestSchema = z.object({
  adoOrgUrl: z.string().url(),
  pat: z.string().min(1),
});

export type LoginRequestBody = z.infer<typeof loginRequestSchema>;
