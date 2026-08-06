import { describe, it, expect } from 'vitest';
import { computeEtaMinutes, formatEtaMinutes } from './eta';

describe('computeEtaMinutes', () => {
  it('returns a small constant for baseline regardless of block count', () => {
    expect(computeEtaMinutes(10, 'baseline')).toBeLessThan(2);
    expect(computeEtaMinutes(500, 'baseline')).toBeLessThan(2);
  });

  it('floors survey estimates at 15 minutes for a tiny document', () => {
    expect(computeEtaMinutes(1, 'survey')).toBeGreaterThanOrEqual(15);
  });

  it('has no upper cap -- a large document must scale past 40 minutes, not clamp there', () => {
    // Regression: this previously clamped to 40 minutes regardless of size,
    // actively misleading an engineer submitting a 500+ page document (a
    // real ~682-block document's true estimate is well over 300 minutes).
    expect(computeEtaMinutes(682, 'survey')).toBeGreaterThan(40);
    expect(computeEtaMinutes(100000, 'survey')).toBeGreaterThan(40);
  });

  it('scales survey estimate with block count', () => {
    const small = computeEtaMinutes(20, 'survey');
    const large = computeEtaMinutes(80, 'survey');
    expect(large).toBeGreaterThan(small);
  });
});

describe('formatEtaMinutes', () => {
  it('renders under an hour as plain minutes', () => {
    expect(formatEtaMinutes(42)).toBe('42 min');
  });

  it('renders an even number of hours with no minutes remainder', () => {
    expect(formatEtaMinutes(120)).toBe('2h');
  });

  it('renders hours and a minutes remainder together', () => {
    expect(formatEtaMinutes(135)).toBe('2h 15m');
  });

  it('rounds a fractional minute count before formatting, crossing the hour boundary if rounding pushes it there', () => {
    expect(formatEtaMinutes(59.6)).toBe('1h');
  });
});
