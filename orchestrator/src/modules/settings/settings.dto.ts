import { z } from 'zod';

// Inclusive [0, 1] -- mirrors check_for_duplicates.py's own "similarity is a
// cosine score in [0, 1]" contract. No format beyond that: a customer
// deciding this value is trusted to pick a sane number, same trust level
// every other Settings-window-style control in this app already extends.
export const updateAppSettingsSchema = z.object({
  dedupThreshold: z.number().finite().min(0).max(1),
});

export type UpdateAppSettingsBody = z.infer<typeof updateAppSettingsSchema>;
