import { describe, it, expect } from 'vitest';
import { formatEtaMinutes, formatEtaRange, estimateLine, formatTokenCount, formatUsdRange, tokenForecastLine } from './eta';
import type { TokenForecast } from '../api/jobs';

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

// P5: a SURVEY job of a file the result cache already holds is served from it in seconds, not the history-based range.
describe('estimateLine', () => {
  it('says a few seconds when this file was already processed, whatever the range says', () => {
    expect(estimateLine({ lowerMinutes: 20, upperMinutes: 35 }, true)).toEqual({ value: 'A few seconds', note: 'this file was already processed' });
    expect(estimateLine(undefined, true)).toEqual({ value: 'A few seconds', note: 'this file was already processed' });
  });

  it('shows the server range, typically, otherwise', () => {
    expect(estimateLine({ lowerMinutes: 20, upperMinutes: 35 }, false)).toEqual({ value: '20 min – 35 min', note: 'typically, once it starts' });
    expect(estimateLine({ lowerMinutes: 1, upperMinutes: 1 }, false)).toEqual({ value: '1 min', note: 'typically, once it starts' });
  });

  it('is null with no estimate yet and no cached result', () => {
    expect(estimateLine(undefined, false)).toBeNull();
  });
});

describe('formatTokenCount', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [45_000, '45k'],
    [999_400, '999k'],
    [1_200_000, '1.2M'],
    [12_500_000, '12.5M'],
  ])('writes %i as %s', (tokens, text) => {
    expect(formatTokenCount(tokens)).toBe(text);
  });
});

describe('formatUsdRange', () => {
  it('keeps cents under ten dollars and rounds above, with a thousands separator', () => {
    expect(formatUsdRange({ low: 4.2, high: 18 })).toBe('$4.20 – $18');
    expect(formatUsdRange({ low: 950, high: 1_800 })).toBe('$950 – $1,800');
  });
});

describe('tokenForecastLine', () => {
  const forecast = (over: Partial<TokenForecast> = {}): TokenForecast => ({
    documentTokens: 100_000,
    inputTokens: { low: 600_000, likely: 1_100_000, high: 1_500_000 },
    outputTokens: { low: 90_000, likely: 297_000, high: 600_000 },
    requiresConfirmation: false,
    ...over,
  });

  it('is null without a forecast', () => {
    expect(tokenForecastLine(undefined)).toBeNull();
  });

  it('gives the token range of input plus output, with no money when no price is configured', () => {
    expect(tokenForecastLine(forecast())).toEqual({ value: '690k – 2.1M tokens', note: 'rough forecast of model use' });
  });

  it('adds the cost range only when the server priced it', () => {
    expect(tokenForecastLine(forecast({ costUsd: { low: 4.2, high: 18 } }))).toEqual({
      value: '690k – 2.1M tokens · $4.20 – $18',
      note: 'rough forecast of model use and cost',
    });
  });
});

