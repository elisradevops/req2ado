import { describe, it, expect } from 'vitest';
import { flaggedDiffEntryReason, isFlaggedDiffEntry, isLowQualityEntry, isScoredType } from './diffFlagging';

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

  it('never flags an Epic or Feature, whatever its grounding, score or confidence: only Requirements are scored', () => {
    for (const type of ['Epic', 'Feature']) {
      expect(isFlaggedDiffEntry({ type, groundingScore: 0.01, qualityScore: 5, qualityConfidence: 'low' })).toBe(false);
      expect(flaggedDiffEntryReason({ type, groundingScore: 0.01, qualityScore: 5, qualityConfidence: 'low' })).toBeNull();
      expect(isLowQualityEntry({ type, qualityScore: 5 })).toBe(false);
    }
    expect(isScoredType('Requirement')).toBe(true);
    expect(isScoredType(undefined)).toBe(true);
    expect(isScoredType('Epic')).toBe(false);
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

describe('flaggedDiffEntryReason', () => {
  it('is null when the entry is not flagged', () => {
    expect(flaggedDiffEntryReason({ groundingScore: 0.9, qualityScore: 95 })).toBeNull();
  });

  it('names low confidence specifically when scores are otherwise healthy', () => {
    // The exact case M2 exists for: every other visible number looks fine,
    // so the tooltip must not fall back to a generic grounding/quality
    // message -- it has to name confidence.
    const reason = flaggedDiffEntryReason({ groundingScore: 0.9, qualityScore: 95, qualityConfidence: 'low' });
    expect(reason).toMatch(/unsure/i);
    expect(reason).not.toMatch(/grounding|quality score/i);
  });

  it('names low grounding when that is the only flagged condition', () => {
    const reason = flaggedDiffEntryReason({ groundingScore: 0.1, qualityScore: 95 });
    expect(reason).toMatch(/grounding/i);
    expect(reason).not.toMatch(/unsure/i);
  });

  it('names low quality when that is the only flagged condition', () => {
    const reason = flaggedDiffEntryReason({ groundingScore: 0.9, qualityScore: 10 });
    expect(reason).toMatch(/quality score/i);
    expect(reason).not.toMatch(/unsure|grounding/i);
  });

  it('combines all applicable reasons when more than one condition is flagged', () => {
    const reason = flaggedDiffEntryReason({ groundingScore: 0.1, qualityScore: 10, qualityConfidence: 'low' });
    expect(reason).toMatch(/grounding/i);
    expect(reason).toMatch(/quality score/i);
    expect(reason).toMatch(/unsure/i);
  });
});
