import { describe, it, expect } from 'vitest';
import { isSameAsSource } from './SourcePane';

describe('isSameAsSource', () => {
  it('is true when the item text is the quote, whatever the whitespace, punctuation or markdown', () => {
    expect(isSameAsSource('**The unit** shall boot,\nwithin 5 s.', { kind: 'text', text: 'The unit shall boot, within 5 s.' })).toBe(true);
  });

  it('is false for a rewritten item, a shortened quote, or a quote that is not plain text', () => {
    expect(isSameAsSource('The unit shall boot within five seconds.', { kind: 'text', text: 'The unit shall boot within 5 s.' })).toBe(false);
    expect(isSameAsSource('Same words', { kind: 'text', text: 'Same words', truncated: true })).toBe(false);
    expect(isSameAsSource('Same words', { kind: 'section', text: 'Same words' })).toBe(false);
  });

  it('compares Hebrew text by its letters too', () => {
    expect(isSameAsSource('היחידה תאתחל תוך 5 שניות.', { kind: 'text', text: 'היחידה תאתחל תוך 5 שניות' })).toBe(true);
  });
});
