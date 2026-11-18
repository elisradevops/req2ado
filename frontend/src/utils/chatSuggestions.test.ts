import { describe, it, expect } from 'vitest';
import { chatSuggestions } from './chatSuggestions';

const labels = (list: ReturnType<typeof chatSuggestions>): string[] => list.map((s) => s.label);

describe('chatSuggestions', () => {
  it('offers the weakest real categories first, at most three, then the title', () => {
    const scores = { testability: 20, clarity: 40, atomicity: 55, style: 65, rationale: 90 };
    expect(labels(chatSuggestions(scores, true, 'requirement'))).toEqual([
      'Add a measurable pass/fail condition',
      'Remove vague words',
      'Split into separate requirements',
      'Suggest a better title',
    ]);
  });

  it('never offers "make it testable" to an item that scored well on testability', () => {
    expect(labels(chatSuggestions({ testability: 95, clarity: 90 }, true, 'requirement'))).toEqual(['Suggest a better title']);
  });

  it('offers only the title for an Epic or Feature, or when there are no scores', () => {
    expect(labels(chatSuggestions({ testability: 1 }, false, 'feature'))).toEqual(['Suggest a better title']);
    expect(labels(chatSuggestions(null, true, 'requirement'))).toEqual(['Suggest a better title']);
  });

  it('treats a compound flag as weak atomicity, once', () => {
    expect(labels(chatSuggestions({ atomicity: 30 }, true, 'requirement', true))).toEqual(['Split into separate requirements', 'Suggest a better title']);
    expect(labels(chatSuggestions({}, true, 'requirement', true))[0]).toBe('Split into separate requirements');
  });
});
