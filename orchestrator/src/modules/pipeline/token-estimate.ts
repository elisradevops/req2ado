import type { CanonicalDoc } from '@req2ado/shared-ts';

// A rough, honest forecast of what a SURVEY run will spend, shown before Start so a large file is a decision and not a surprise.
// Every constant below is an ESTIMATE from reading the pipeline (which stages send the document, how often, with what repeated prompt
// overhead), not a measurement: the per-job token ledger (JobTokenUsage) now records the real numbers, and these should be tuned against it.
// The range is deliberately wide for that reason.

/** Tokens per character. English is about a quarter; Hebrew tokenises far worse (several letters per token at best). */
const TOKENS_PER_CHAR_LATIN = 0.25;
const TOKENS_PER_CHAR_HEBREW = 0.45;

/** Input tokens of a whole run as a multiple of the document's own tokens: the document is sent several times (overview, study, structure,
 *  content) and each batch of items repeats a fixed prompt; acceptance criteria is the largest part. */
const INPUT_MULTIPLE = { low: 6, likely: 11, high: 15 } as const;
/** Output tokens as a share of the run's input tokens. */
const OUTPUT_RATIO = { low: 0.15, likely: 0.27, high: 0.4 } as const;
/** One vision call per figure (the judge and the caption). */
const VISION_INPUT_PER_FIGURE = 2100;
const VISION_OUTPUT_PER_FIGURE = 250;

export interface TokenRange {
  low: number;
  likely: number;
  high: number;
}

export interface ModelPrice {
  /** US dollars per million input tokens. */
  inputPerMTok: number;
  /** US dollars per million output tokens. */
  outputPerMTok: number;
}

export interface TokenEstimate {
  documentTokens: number;
  inputTokens: TokenRange;
  outputTokens: TokenRange;
  /** Only when a price is configured for the model: never a guessed price. */
  costUsd?: { low: number; high: number };
  /** True when the likely total is above the configured threshold, so the wizard asks before Start. */
  requiresConfirmation: boolean;
}

const isHebrew = (code: number): boolean => code >= 0x0590 && code <= 0x05ff;

/** The document's size in tokens, from its text (blocks and table cells), weighting Hebrew letters as the costlier script they are. */
export function documentTokensOf(doc: Pick<CanonicalDoc, 'blocks' | 'tables'>): number {
  let chars = 0;
  let hebrew = 0;
  const count = (text: string | undefined | null): void => {
    if (!text) return;
    chars += text.length;
    for (let i = 0; i < text.length; i += 1) if (isHebrew(text.charCodeAt(i))) hebrew += 1;
  };
  for (const block of doc.blocks) count(block.text);
  for (const table of doc.tables) for (const row of table.cells) for (const cell of row) count(cell?.text);
  return Math.round((chars - hebrew) * TOKENS_PER_CHAR_LATIN + hebrew * TOKENS_PER_CHAR_HEBREW);
}

const scale = (base: number, factor: { low: number; likely: number; high: number }): TokenRange => ({
  low: Math.round(base * factor.low),
  likely: Math.round(base * factor.likely),
  high: Math.round(base * factor.high),
});

export class CostEstimator {
  constructor(
    private readonly prices: Readonly<Record<string, ModelPrice>> = {},
    /** 0 (the default) never asks. */
    private readonly confirmAboveTokens: number = 0,
    private readonly defaultModel?: string,
  ) {}

  private priceFor(model: string | undefined): ModelPrice | undefined {
    const wanted = (model ?? this.defaultModel ?? '').toLowerCase();
    for (const [name, price] of Object.entries(this.prices)) if (name.toLowerCase() === wanted && wanted !== '') return price;
    return this.prices['*'];
  }

  estimate(args: { documentTokens: number; figureCount: number; model?: string }): TokenEstimate {
    const documentTokens = Math.max(0, Math.round(args.documentTokens));
    const figures = Math.max(0, Math.round(args.figureCount));
    const inputTokens = scale(documentTokens, INPUT_MULTIPLE);
    const outputTokens: TokenRange = {
      low: Math.round(inputTokens.low * OUTPUT_RATIO.low),
      likely: Math.round(inputTokens.likely * OUTPUT_RATIO.likely),
      high: Math.round(inputTokens.high * OUTPUT_RATIO.high),
    };
    for (const key of ['low', 'likely', 'high'] as const) {
      inputTokens[key] += figures * VISION_INPUT_PER_FIGURE;
      outputTokens[key] += figures * VISION_OUTPUT_PER_FIGURE;
    }
    const price = this.priceFor(args.model);
    const cost = (input: number, output: number): number => (input * price!.inputPerMTok + output * price!.outputPerMTok) / 1_000_000;
    return {
      documentTokens,
      inputTokens,
      outputTokens,
      ...(price
        ? { costUsd: { low: roundMoney(cost(inputTokens.low, outputTokens.low)), high: roundMoney(cost(inputTokens.high, outputTokens.high)) } }
        : {}),
      requiresConfirmation: this.confirmAboveTokens > 0 && inputTokens.likely + outputTokens.likely > this.confirmAboveTokens,
    };
  }
}

const roundMoney = (usd: number): number => (usd >= 10 ? Math.round(usd) : Math.round(usd * 100) / 100);

/**
 * Parses LLM_MODEL_PRICES: a JSON object of model id (case-insensitive; "*" for any other model) to
 * { "inputPerMTok": n, "outputPerMTok": n }, in US dollars per million tokens. Throws on anything else, so a misconfigured price is
 * seen at startup instead of silently showing no cost.
 */
export function parseModelPrices(json: string | undefined): Record<string, ModelPrice> {
  if (!json || !json.trim()) return {};
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('LLM_MODEL_PRICES must be a JSON object of model id to price');
  const prices: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    const price = value as Partial<ModelPrice> | null;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!price || !ok(price.inputPerMTok) || !ok(price.outputPerMTok)) {
      throw new Error(`LLM_MODEL_PRICES["${model}"] needs non-negative numbers inputPerMTok and outputPerMTok`);
    }
    prices[model] = { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
  }
  return prices;
}
