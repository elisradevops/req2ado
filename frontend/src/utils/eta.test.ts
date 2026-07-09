import { describe, it, expect } from 'vitest';
import { computeEtaMinutes } from './eta';

describe('computeEtaMinutes', () => {
  it('returns a small constant for baseline regardless of block count', () => {
    expect(computeEtaMinutes(10, 'baseline')).toBeLessThan(2);
    expect(computeEtaMinutes(500, 'baseline')).toBeLessThan(2);
  });

  it('clamps survey estimates to the documented 15-40 minute range', () => {
    expect(computeEtaMinutes(1, 'survey')).toBeGreaterThanOrEqual(15);
    expect(computeEtaMinutes(100000, 'survey')).toBeLessThanOrEqual(40);
  });

  it('scales survey estimate with block count within the range', () => {
    const small = computeEtaMinutes(20, 'survey');
    const large = computeEtaMinutes(80, 'survey');
    expect(large).toBeGreaterThanOrEqual(small);
  });
});
