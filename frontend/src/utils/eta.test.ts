import { describe, it, expect } from 'vitest';
import { formatEtaMinutes, formatEtaRange } from './eta';

// computeEtaMinutes was deleted from this file (DESIGN.md §18's ledger) --
// the ETA is now computed server-side from real completed-job history, not
// a static client-side formula. Its no-cap regression coverage moved to
// orchestrator/test/eta.service.spec.ts ("never caps the estimate for a
// genuinely large document"). The claim this describe block's old comment
// made -- "a real ~682-block document's true estimate is well over 300
// minutes" -- is the exact hand-picked-formula prediction that was found
// wrong by ~4x against the real completed job (AirPro_BP_ICD_Revision_0.3.docx,
// 682 blocks, 39 figures, ~90 real minutes); it is not restated here.

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

describe('formatEtaRange', () => {
  it('formats both bounds independently through formatEtaMinutes', () => {
    expect(formatEtaRange(20, 35)).toEqual({ lower: '20 min', upper: '35 min' });
  });

  it('crosses the hour boundary independently on each bound', () => {
    expect(formatEtaRange(45, 75)).toEqual({ lower: '45 min', upper: '1h 15m' });
  });

  it('handles an equal lower/upper bound (e.g. the SURVEY floor with no real history yet)', () => {
    expect(formatEtaRange(15, 15)).toEqual({ lower: '15 min', upper: '15 min' });
  });
});
