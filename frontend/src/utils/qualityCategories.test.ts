import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { categoryLabel, weakestCategory, WEAK_CATEGORY_SCORE } from './qualityCategories';

describe('weakestCategory', () => {
  it('returns the lowest-scoring category with its score', () => {
    expect(weakestCategory({ clarity: 80, testability: 35, style: 60 })).toEqual({ key: 'testability', score: 35, checklistText: undefined });
  });

  it('carries the checklist text for that category when one was found', () => {
    expect(weakestCategory({ clarity: 80, testability: 35 }, { testability: 'Each requirement has a pass/fail test.' })).toEqual({
      key: 'testability',
      score: 35,
      checklistText: 'Each requirement has a pass/fail test.',
    });
  });

  it('breaks a tie alphabetically, whatever the map order (the same rule the chat uses)', () => {
    expect(weakestCategory({ style: 50, clarity: 50 })?.key).toBe('clarity');
    expect(weakestCategory({ clarity: 50, style: 50 })?.key).toBe('clarity');
  });

  it('treats a real 0 as the weakest score, not as missing', () => {
    expect(weakestCategory({ clarity: 70, style: 0 })).toMatchObject({ key: 'style', score: 0 });
  });

  it('ignores non-finite scores', () => {
    expect(weakestCategory({ clarity: Number.NaN, style: 55 })).toMatchObject({ key: 'style', score: 55 });
    expect(weakestCategory({ clarity: Number.NaN })).toBeNull();
  });

  it('returns null for missing or empty scores (BASELINE, manual entry, old job)', () => {
    expect(weakestCategory(null)).toBeNull();
    expect(weakestCategory(undefined)).toBeNull();
    expect(weakestCategory({})).toBeNull();
  });

  it('returns nothing when the lowest score is at or above the bar, and the category when below it', () => {
    expect(weakestCategory({ clarity: 70, style: 90 }, null, WEAK_CATEGORY_SCORE)).toBeNull();
    expect(weakestCategory({ clarity: 69, style: 90 }, null, WEAK_CATEGORY_SCORE)).toMatchObject({ key: 'clarity', score: 69 });
  });
});

describe('categoryLabel', () => {
  it('capitalizes every word of a snake_case or kebab-case key', () => {
    expect(categoryLabel('completeness_as_requirement')).toBe('Completeness As Requirement');
    expect(categoryLabel('well-formed')).toBe('Well Formed');
    expect(categoryLabel('clarity')).toBe('Clarity');
  });
});

// The chat's weak-category bar is stated twice: here, and in ingestion's chat prompt. Nothing else ties
// them together, so this fails the moment one moves without the other.
describe('WEAK_CATEGORY_SCORE', () => {
  // Run from frontend/ (pnpm test) or from the repo root; skipped only where ingestion is not checked out.
  const ingestionFile =
    ['../ingestion', 'ingestion']
      .map((dir) => resolve(process.cwd(), dir, 'app/chat/chat_service.py'))
      .find((candidate) => existsSync(candidate)) ?? '';

  it.skipIf(ingestionFile === '')("equals ingestion's _WEAK_CATEGORY_SCORE", () => {
    const match = /^_WEAK_CATEGORY_SCORE\s*=\s*(\d+)\s*$/m.exec(readFileSync(ingestionFile, 'utf8'));
    expect(match).not.toBeNull();
    expect(WEAK_CATEGORY_SCORE).toBe(Number(match?.[1]));
  });
});
