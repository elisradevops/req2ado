import { describe, it, expect } from 'vitest';
import { isFlaggedDiffEntry } from './diffFlagging';

describe('isFlaggedDiffEntry', () => {
  it('is false when both scores are null', () => {
    expect(isFlaggedDiffEntry({ groundingScore: null, qualityScore: null })).toBe(false);
  });

  it('is true when groundingScore is below 0.2', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.1, qualityScore: null })).toBe(true);
  });

  it('is true when qualityScore is below 50', () => {
    expect(isFlaggedDiffEntry({ groundingScore: null, qualityScore: 30 })).toBe(true);
  });

  it('is false when both scores are healthy', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.9, qualityScore: 95 })).toBe(false);
  });
});
