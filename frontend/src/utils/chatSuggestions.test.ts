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

  it('names a category the organisation defined itself, as the user sees it, instead of dropping it', () => {
    const [own] = chatSuggestions({ 'Numerical limits include units, tolerances, and measurement point.': 30 }, true, 'requirement');
    expect(own.label).toBe('Improve: Numerical limits include units, tolerances, and measurement point');
    expect(own.prompt).toMatch(/meets this check: Numerical limits include/);
  });

  it('offers an Epic or Feature suggestions drawn from the items nested under it, only when there are some', () => {
    expect(labels(chatSuggestions(null, false, 'epic', false, true))).toEqual([
      'Restate it from its items',
      'Check its items belong together',
      'Suggest a better title',
    ]);
    expect(chatSuggestions(null, false, 'epic', false, true).at(-1)!.prompt).toMatch(/items nested under it/);
    expect(labels(chatSuggestions(null, false, 'epic', false, false))).toEqual(['Suggest a better title']);
  });
});
