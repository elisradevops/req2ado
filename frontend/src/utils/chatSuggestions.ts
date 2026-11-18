import { WEAK_CATEGORY_SCORE } from './qualityCategories';

export interface ChatSuggestion {
  label: string;
  effect: string;
  prompt: string;
}

// What the assistant offers, drawn from the item's own weak categories (below WEAK_CATEGORY_SCORE), at most three, then a title. An item with no
// real weakness, a stale score, an Epic or a Feature gets the title suggestion only: a generic "make it testable" next to a part number that
// scored 95 on testability is noise (DESIGN.md §11.4.5).
const BY_CATEGORY: Record<string, (noun: string) => ChatSuggestion> = {
  testability: () => ({
    label: 'Add a measurable pass/fail condition',
    effect: 'rewrite so it can be checked, with clear acceptance criteria',
    prompt: 'Rewrite this so it is independently testable, with a measurable pass/fail condition and clear acceptance criteria.',
  }),
  clarity: () => ({
    label: 'Remove vague words',
    effect: 'remove ambiguity and vague terms',
    prompt: 'Tighten the wording: remove ambiguity and vague terms.',
  }),
  atomicity: () => ({
    label: 'Split into separate requirements',
    effect: 'this item keeps the first one; the others are listed for you to add as new items',
    prompt:
      'This item combines more than one requirement. Keep only the first requirement in this item, and list each remaining requirement as its own complete statement. Ignore any "Proposed acceptance criteria" or "Needs author input" section: those are generated notes, not requirements.',
  }),
  style: () => ({
    label: 'Name who does the action',
    effect: 'say who or what performs the action, in a "shall" statement',
    prompt: 'Rewrite this as a clear "shall" statement that names who or what does the action.',
  }),
  rationale: (noun) => ({
    label: 'Add why this is needed',
    effect: `add a brief rationale explaining why this ${noun} exists`,
    prompt: `Add a brief rationale explaining why this ${noun} exists.`,
  }),
};

export function chatSuggestions(
  categoryScores: Record<string, number> | null | undefined,
  scored: boolean,
  noun: string,
  compound = false,
): ChatSuggestion[] {
  const out: ChatSuggestion[] = [];
  if (scored) {
    const weak = Object.entries(categoryScores ?? {})
      .filter(([key, score]) => Number.isFinite(score) && score < WEAK_CATEGORY_SCORE && BY_CATEGORY[key])
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .map(([key]) => key);
    // A "compound" flag is the same fact as weak atomicity.
    if (compound && !weak.includes('atomicity')) weak.unshift('atomicity');
    for (const key of weak.slice(0, 3)) out.push(BY_CATEGORY[key](noun));
  }
  out.push({
    label: 'Suggest a better title',
    effect: `a more specific, concise title for this ${noun}`,
    prompt: `Suggest a more specific, concise title for this ${noun} based on its description.`,
  });
  return out;
}
