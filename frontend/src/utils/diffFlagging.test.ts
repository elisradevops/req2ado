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

  it('flags an Epic with a grounding score below the higher parent threshold but above the base threshold', () => {
    expect(isFlaggedDiffEntry({ type: 'Epic', groundingScore: 0.3, qualityScore: 100 })).toBe(true);
  });

  it('does not flag a Requirement with the same grounding score that would flag an Epic', () => {
    expect(isFlaggedDiffEntry({ type: 'Requirement', groundingScore: 0.3, qualityScore: 100 })).toBe(false);
  });

  it('flags a low-confidence entry whose scores are otherwise fine', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'low' })).toBe(true);
  });

  it('does not flag high or medium confidence', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'high' })).toBe(false);
    expect(isFlaggedDiffEntry({ groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'medium' })).toBe(false);
  });

  it('does not flag an absent or null confidence value', () => {
    expect(isFlaggedDiffEntry({ groundingScore: 0.9, qualityScore: 95, qualityConfidence: null })).toBe(false);
    expect(isFlaggedDiffEntry({ groundingScore: 0.9, qualityScore: 95 })).toBe(false);
  });
});
