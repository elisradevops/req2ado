import { CostEstimator, documentTokensOf, parseModelPrices } from '../src/modules/pipeline/token-estimate';

const block = (text: string) => ({ id: 'b', kind: 'paragraph' as const, text, source_ref: { document_path: 'x', start_offset: 0, end_offset: 0 } });
const doc = (texts: string[], tableCells: (string | null)[][][] = []) =>
  ({
    blocks: texts.map(block),
    tables: tableCells.map((cells, i) => ({ id: `t${i}`, cells: cells.map((row) => row.map((text) => (text === null ? null : { text }))) })),
  }) as any;

describe('documentTokensOf', () => {
  it('counts English text at a quarter token per character', () => {
    expect(documentTokensOf(doc(['a'.repeat(4000)]))).toBe(1000);
  });

  it('counts Hebrew letters as the costlier script, and a mixed text in proportion', () => {
    expect(documentTokensOf(doc(['א'.repeat(1000)]))).toBe(450);
    expect(documentTokensOf(doc(['a'.repeat(1000) + 'א'.repeat(1000)]))).toBe(250 + 450);
  });

  it('includes table cells, skipping spanned (null) positions', () => {
    expect(documentTokensOf(doc([], [[['a'.repeat(400), null], ['b'.repeat(400), '']]]))).toBe(200);
  });

  it('is 0 for an empty document', () => {
    expect(documentTokensOf(doc([]))).toBe(0);
  });
});

describe('CostEstimator', () => {
  const prices = { 'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 }, '*': { inputPerMTok: 1, outputPerMTok: 5 } };

  it('forecasts a wide range of input and output tokens from the document size', () => {
    const e = new CostEstimator().estimate({ documentTokens: 100_000, figureCount: 0 });

    expect(e.inputTokens).toEqual({ low: 600_000, likely: 1_100_000, high: 1_500_000 });
    expect(e.outputTokens).toEqual({ low: 90_000, likely: 297_000, high: 600_000 });
    expect(e.documentTokens).toBe(100_000);
  });

  it('adds one vision call per figure', () => {
    const base = new CostEstimator().estimate({ documentTokens: 100_000, figureCount: 0 });
    const withFigures = new CostEstimator().estimate({ documentTokens: 100_000, figureCount: 40 });

    expect(withFigures.inputTokens.likely - base.inputTokens.likely).toBe(40 * 2100);
    expect(withFigures.outputTokens.likely - base.outputTokens.likely).toBe(40 * 250);
  });

  it('gives a dollar range only when a price is configured for the model, never a guessed one', () => {
    const none = new CostEstimator().estimate({ documentTokens: 100_000, figureCount: 0, model: 'claude-opus-5-5' });
    expect(none.costUsd).toBeUndefined();

    const priced = new CostEstimator(prices).estimate({ documentTokens: 100_000, figureCount: 0, model: 'Claude-Opus-5-5' });
    // low: 600k in * $4 + 90k out * $20 = 2.4 + 1.8 ; high: 1.5M * 4 + 600k * 20 = 6 + 12
    expect(priced.costUsd).toEqual({ low: 4.2, high: 18 });
  });

  it('falls back to the "*" price for another model, and to the default model when none is given', () => {
    expect(new CostEstimator(prices).estimate({ documentTokens: 100_000, figureCount: 0, model: 'other' }).costUsd?.high).toBe(4.5);
    expect(new CostEstimator(prices, 0, 'claude-opus-5-5').estimate({ documentTokens: 100_000, figureCount: 0 }).costUsd?.high).toBe(18);
  });

  it('asks for confirmation only above the configured threshold of the likely total, and never when it is 0', () => {
    const args = { documentTokens: 100_000, figureCount: 0 }; // likely total 1,397,000
    expect(new CostEstimator({}, 0).estimate(args).requiresConfirmation).toBe(false);
    expect(new CostEstimator({}, 1_000_000).estimate(args).requiresConfirmation).toBe(true);
    expect(new CostEstimator({}, 2_000_000).estimate(args).requiresConfirmation).toBe(false);
  });

  it('treats a negative or fractional size safely', () => {
    expect(new CostEstimator().estimate({ documentTokens: -5, figureCount: -1 }).inputTokens.likely).toBe(0);
  });
});

describe('parseModelPrices', () => {
  it('reads a JSON map of model to dollars per million tokens', () => {
    expect(parseModelPrices('{"m":{"inputPerMTok":2,"outputPerMTok":10}}')).toEqual({ m: { inputPerMTok: 2, outputPerMTok: 10 } });
  });

  it('is empty when unset or blank', () => {
    expect(parseModelPrices(undefined)).toEqual({});
    expect(parseModelPrices('  ')).toEqual({});
  });

  it.each(['not json', '[]', '{"m":{"inputPerMTok":-1,"outputPerMTok":1}}', '{"m":{"inputPerMTok":"2","outputPerMTok":1}}', '{"m":null}'])(
    'rejects %s loudly, so a misconfigured price is seen at startup',
    (json) => {
      expect(() => parseModelPrices(json)).toThrow();
    },
  );
});
