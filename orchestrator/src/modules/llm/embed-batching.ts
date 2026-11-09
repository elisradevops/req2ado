// Embedding request sizing: how many texts, and how many tokens, one embeddings call may carry for a given model, how to
// pack a list of chunks into calls that respect that, and how to shrink when the upstream still says "too big". Pure: no
// network, no Nest; the client (openwebui.client.ts) owns sending. Mirrors model-capabilities.ts: a table of families with
// `sources` and checked dates, and a fact the table lacks is learned from the upstream's answer (EmbedLimitMemory).

export interface EmbedSource {
  url: string;
  /** ISO date the fact was last checked against the source. */
  checked: string;
  note?: string;
}

export interface EmbedCapability {
  family: string;
  /** Regular expression (case-insensitive) matched against the model name as the proxy lists it. */
  match: string;
  maxInputsPerRequest: number;
  maxTokensPerInput: number;
  maxTokensPerRequest: number;
  /** The token counts we compute are exact for this family (cl100k for OpenAI/Azure); otherwise they only approximate. */
  tokenizerExact: boolean;
  sources: EmbedSource[];
}

const AZURE_SOURCES: EmbedSource[] = [
  { url: 'https://learn.microsoft.com/azure/foundry/openai/how-to/embeddings', checked: '2026-11-09', note: 'at most 2,048 inputs per request; 300,000 tokens summed per request; 429 carries retry-after-ms' },
  { url: 'https://learn.microsoft.com/azure/foundry/openai/concepts/models', checked: '2026-11-09', note: '8,192 tokens per input (2,046 for text-embedding-ada-002 version 1)' },
];

// The documented ceilings are 8,192 tokens per input and 300,000 per request; the table keeps headroom (7,500 / 250,000)
// because the splitter and the upstream may count slightly differently.
export const EMBED_CAPABILITIES: readonly EmbedCapability[] = [
  {
    family: 'openai-text-embedding-3',
    match: 'text-embedding-3-(small|large)',
    maxInputsPerRequest: 2048,
    maxTokensPerInput: 7500,
    maxTokensPerRequest: 250000,
    tokenizerExact: true,
    sources: AZURE_SOURCES,
  },
  {
    // An unknown ada-002 version is treated as version 2.
    family: 'openai-ada-002',
    match: 'ada-002|text-embedding-ada',
    maxInputsPerRequest: 2048,
    maxTokensPerInput: 7500,
    maxTokensPerRequest: 250000,
    tokenizerExact: true,
    sources: AZURE_SOURCES,
  },
  {
    family: 'ollama-embedding',
    match: 'nomic-embed|mxbai|bge|all-minilm|snowflake-arctic-embed|granite-embedding|qwen3-embedding',
    maxInputsPerRequest: 64,
    maxTokensPerInput: 512,
    maxTokensPerRequest: 32000,
    tokenizerExact: false,
    sources: [
      { url: 'local Ollama probe of these families', checked: '2026-11-09', note: 'survived 64 inputs per call, crashed on 1,094' },
    ],
  },
];

// ada-002 version 1 (2,046 tokens per input) is deliberately NOT matched by name: the model name does not say the version.
// It is reachable only through an explicit override or a learned value (`learned: ADA_002_V1_LIMITS`).
export const ADA_002_V1_LIMITS: Partial<EmbedLimits> = { tokensPerInput: 2046 };

/** Conservative limits for a model neither the name nor the base model identifies. */
export const EMBED_DEFAULT: EmbedCapability = {
  family: 'default',
  match: '(?!)',
  maxInputsPerRequest: 256,
  maxTokensPerInput: 7500,
  maxTokensPerRequest: 100000,
  tokenizerExact: false,
  sources: [{ url: 'none: no documented limit for an unidentified model', checked: '2026-11-09', note: 'chosen below every known family except Ollama' }],
};

/** cl100k only approximates the tokenizers of the non-exact families; keep this much of each token cap. */
export const APPROX_TOKENIZER_MARGIN = 0.8;

export interface EmbedLimits {
  inputs: number;
  tokensPerInput: number;
  tokensPerRequest: number;
  family: string;
  source: 'env' | 'learned' | 'table' | 'base-model' | 'default';
}

export interface EmbedLimitOptions {
  env?: { maxInputs?: number; maxTokens?: number };
  learned?: Partial<Pick<EmbedLimits, 'inputs' | 'tokensPerInput' | 'tokensPerRequest'>>;
  /** LiteLLM `base_model` / `litellm_params.model`, for opaque Azure deployment names like `emb-prod-01`. */
  baseModel?: string;
  /** `max_input_tokens` from the model info; lowers the per-input cap when smaller. */
  maxInputTokensFromInfo?: number;
}

function findCapability(name: string | undefined): EmbedCapability | undefined {
  if (!name) return undefined;
  return EMBED_CAPABILITIES.find((c) => new RegExp(c.match, 'i').test(name));
}

/** Precedence: env override, learned (per model), name match, base-model match, default. */
export function resolveEmbedLimits(model: string, opts: EmbedLimitOptions = {}): EmbedLimits {
  let cap = findCapability(model);
  let source: EmbedLimits['source'] = 'table';
  if (!cap) {
    cap = findCapability(opts.baseModel);
    source = 'base-model';
  }
  if (!cap) {
    cap = EMBED_DEFAULT;
    source = 'default';
  }
  const margin = cap.tokenizerExact ? 1 : APPROX_TOKENIZER_MARGIN;
  let inputs = cap.maxInputsPerRequest;
  let tokensPerInput = Math.floor(cap.maxTokensPerInput * margin);
  let tokensPerRequest = Math.floor(cap.maxTokensPerRequest * margin);

  const info = opts.maxInputTokensFromInfo;
  if (typeof info === 'number' && Number.isFinite(info) && info > 0) tokensPerInput = Math.min(tokensPerInput, info);

  const l = opts.learned;
  if (l) {
    if (l.inputs !== undefined) inputs = l.inputs;
    if (l.tokensPerInput !== undefined) tokensPerInput = l.tokensPerInput;
    if (l.tokensPerRequest !== undefined) tokensPerRequest = l.tokensPerRequest;
    if (l.inputs !== undefined || l.tokensPerInput !== undefined || l.tokensPerRequest !== undefined) source = 'learned';
  }
  const e = opts.env;
  if (e) {
    if (e.maxInputs !== undefined) {
      inputs = e.maxInputs;
      source = 'env';
    }
    if (e.maxTokens !== undefined) {
      tokensPerRequest = e.maxTokens;
      source = 'env';
    }
  }
  return { inputs, tokensPerInput, tokensPerRequest, family: cap.family, source };
}

/**
 * Greedy, order-preserving packing into `[start, end)` index ranges: at most `inputs` items and `tokensPerRequest` summed
 * tokens per batch. An item above `tokensPerRequest` still gets a batch of its own; the upstream's answer is the real error.
 */
export function planBatches(
  tokenCounts: number[],
  limits: Pick<EmbedLimits, 'inputs' | 'tokensPerRequest'>,
): Array<[number, number]> {
  const batches: Array<[number, number]> = [];
  let start = 0;
  let sum = 0;
  for (let i = 0; i < tokenCounts.length; i++) {
    const t = tokenCounts[i];
    const count = i - start;
    if (count > 0 && (count >= limits.inputs || sum + t > limits.tokensPerRequest)) {
      batches.push([start, i]);
      start = i;
      sum = 0;
    }
    sum += t;
  }
  if (tokenCounts.length > start) batches.push([start, tokenCounts.length]);
  return batches;
}

/** Enough halvings to take 2,048 inputs down to 1. */
export const MAX_HALVINGS = 11;

export function halveLimits(limits: EmbedLimits): EmbedLimits {
  return {
    ...limits,
    inputs: Math.max(1, Math.floor(limits.inputs / 2)),
    tokensPerRequest: Math.max(1, Math.floor(limits.tokensPerRequest / 2)),
  };
}

// Azure/OpenAI size rejections: "too many inputs", "array too long ... maximum length 2048", "maximum context length",
// "300,000 tokens per request", and a proxy's 413 "Payload Too Large"/"Request too large".
const SIZE_REJECTION =
  /too many inputs|array.*(2048|2,048)|maximum.*(context|request|tokens|number of inputs)|300,?000|payload too large|request too large/i;

export function isEmbedSizeRejection(status: number, body: string): boolean {
  return (status === 400 || status === 413) && SIZE_REJECTION.test(body);
}

// A rejection about ONE input's length ("maximum context length is 8192 tokens, you requested ..."): halving the batch cannot
// fix it and says nothing about the request-size limits. A message about the array / number of inputs is not this kind.
const CONTEXT_REJECTION = /context length|maximum context|input.*(too long|exceed)/i;
const BATCH_SIZE_WORDS = /array|too many inputs|number of inputs|per request/i;

export function isEmbedContextRejection(status: number, body: string): boolean {
  return (status === 400 || status === 413) && CONTEXT_REJECTION.test(body) && !BATCH_SIZE_WORDS.test(body);
}

/** Limits learned from an upstream's rejections, per model, so later calls start from them. */
export class EmbedLimitMemory {
  private readonly byModel = new Map<string, NonNullable<EmbedLimitOptions['learned']>>();

  get(model: string): NonNullable<EmbedLimitOptions['learned']> | undefined {
    return this.byModel.get(model);
  }

  remember(model: string, update: NonNullable<EmbedLimitOptions['learned']>): void {
    this.byModel.set(model, { ...this.byModel.get(model), ...update });
  }
}
