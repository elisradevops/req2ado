import type { KbRetrievalMode } from '../api/kb';

// Whether a file looks like reference material that should be sent in full with every job ("Reference"), judged from
// its name and size only: nothing is read before the user adds it. It is a nudge shown with its reason, never a default
// that is applied silently.
//
// File size is a weak signal for how much TEXT a file holds (a presentation is mostly images), so it never blocks the
// suggestion unless the file is very large, and a large Reference file is warned about instead.

export const LARGE_FILE_WARNING_BYTES = 5 * 1024 * 1024;
const NO_SUGGESTION_ABOVE_BYTES = 10 * 1024 * 1024;

// English and Hebrew words that mark a guide, standard, template or similar document that applies to every job.
const GUIDE_NAME =
  /standard|guideline|guide|style|template|checklist|polic(y|ies)|convention|glossary|cmmi|principles|how[\s_-]?to|הנחיות|מדריך|תקן|נוהל|תבנית|מילון/i;

export interface ModeSuggestion {
  mode: Extract<KbRetrievalMode, 'always_include'>;
  reason: string;
}

export function suggestRetrievalMode(name: string, sizeBytes: number): ModeSuggestion | null {
  if (sizeBytes > NO_SUGGESTION_ABOVE_BYTES) return null;
  return GUIDE_NAME.test(name) ? { mode: 'always_include', reason: 'the name looks like a guide or standard' } : null;
}
