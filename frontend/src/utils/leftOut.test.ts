import { describe, expect, it } from 'vitest';
import { pagesPhrase } from './leftOut';

describe('pagesPhrase', () => {
  it('names one page, one span, or separate spans (front matter and back matter are never one span)', () => {
    expect(pagesPhrase([])).toBe('');
    expect(pagesPhrase([2])).toBe(' (page 2)');
    expect(pagesPhrase([1, 2, 3])).toBe(' (pages 1–3)');
    expect(pagesPhrase([1, 2, 3, 4, 5, 28, 29, 30, 31])).toBe(' (pages 1–5, 28–31)');
    expect(pagesPhrase([3, 1, 1, 7])).toBe(' (pages 1, 3, 7)');
  });
});
