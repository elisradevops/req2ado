import type { LearnedConstraints } from './upstream-negotiation';

// What each model FAMILY behind the proxy refuses and demands in a chat request, so the first attempt is already right
// instead of learning it from a failed call. Facts come from the prod compatibility probes (12 to 19 Oct 2026), the
// captured Open WebUI objects and the vendors' documentation (see `sources`); a fact the table does not state is learned
// from the upstream's answer as before, so an entry that is incomplete costs one retry, never a wrong result.
// Limits (context, output ceiling) are NOT here: the model listing states them per model (model entry schema) and
// ingestion's family rules cover the rest.

export interface CapabilitySource {
  url: string;
  /** ISO date the fact was last checked against the source or against prod. */
  checked: string;
  note?: string;
}

export interface ModelCapability {
  family: string;
  /** Regular expression (case-insensitive) matched against the full model name as the proxy lists it. */
  match: string;
  /** Which output-limit parameter the family takes; `none`: the proxy refuses both, so no limit is sent. */
  tokenParam: 'max_tokens' | 'max_completion_tokens' | 'none';
  /** `fixed`: only this temperature is accepted (the app asks for 0, which is refused). */
  temperature: { mode: 'any' } | { mode: 'fixed'; value: number };
  /** Function tools are refused unless `reasoning_effort` is `none` (for the models matching this expression). */
  toolsRequireReasoningNoneFor?: string;
  /** How a response schema is enforced: native strict structured output, or a synthetic forced tool / prompt only. */
  structuredOutput: 'strict-portable' | 'native-or-tool';
  /** Input and output share one window (gpt-oss): a large output limit leaves no room for the input. */
  outputCountsInContext?: boolean;
  contextTokens?: number;
  sources: CapabilitySource[];
}

export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  {
    family: 'claude-4-and-5',
    match: '(^|/)claude-(opus|sonnet|haiku|fable|mythos)-\\d',
    tokenParam: 'max_tokens',
    temperature: { mode: 'fixed', value: 1 },
    structuredOutput: 'native-or-tool',
    sources: [
      { url: 'prod: claude-opus-4-8, claude-sonnet-4-6 via the proxy', checked: '2026-10-18', note: '"does not support temperature=0. Only temperature=1 is supported"' },
      { url: 'https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs', checked: '2026-10-19' },
    ],
  },
  {
    family: 'gpt-5-reasoning',
    match: '^(?:.*/)?gpt-[56](?:\\.\\d+)?(?!-chat)(?:-.*)?$',
    tokenParam: 'max_completion_tokens',
    temperature: { mode: 'fixed', value: 1 },
    toolsRequireReasoningNoneFor: '(^|/)gpt-(5\\.[6-9]|6)',
    structuredOutput: 'strict-portable',
    sources: [
      { url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/reasoning', checked: '2026-10-19' },
      { url: 'prod: OpenAI/gpt-5.5 and gpt-5.6-terra via the proxy', checked: '2026-10-18', note: "'temperature' does not support 0 ... Only the default (1) value is supported" },
    ],
  },
  {
    family: 'gpt-chat-alias',
    match: '(^|/)(gpt-chat-latest$|gpt-\\d+(\\.\\d+)?-chat)',
    tokenParam: 'none',
    temperature: { mode: 'any' },
    structuredOutput: 'strict-portable',
    sources: [{ url: 'prod: OpenAI/gpt-chat-latest: the proxy turns max_completion_tokens back into max_tokens, which Azure refuses', checked: '2026-10-11' }],
  },
  {
    family: 'gpt-oss',
    match: '(^|/)gpt-oss',
    tokenParam: 'max_completion_tokens',
    temperature: { mode: 'any' },
    structuredOutput: 'strict-portable',
    outputCountsInContext: true,
    contextTokens: 131_072,
    sources: [{ url: 'prod: OpenAI/gpt-oss-120b 400 "Requested token count exceeds the model\'s maximum context length of 131072 tokens"', checked: '2026-10-13' }],
  },
];

const compiled = MODEL_CAPABILITIES.map((entry) => ({ entry, pattern: new RegExp(entry.match, 'i') }));

/** The family a model belongs to, or null for a model the table does not know. */
export function capabilitiesFor(model: string): ModelCapability | null {
  return compiled.find(({ pattern }) => pattern.test(model))?.entry ?? null;
}

/** What negotiation can assume before the first call, or undefined for an unknown model. */
export function seedConstraints(model: string): (LearnedConstraints & { rejected: Set<string> }) | undefined {
  const capability = capabilitiesFor(model);
  if (!capability) return undefined;
  const seed: LearnedConstraints & { rejected: Set<string> } = { rejected: new Set<string>() };
  if (capability.temperature.mode === 'fixed') seed.temperature = capability.temperature.value;
  if (capability.tokenParam === 'max_completion_tokens') seed.tokenParam = 'max_completion_tokens';
  if (capability.tokenParam === 'none') seed.omitTokenLimit = true;
  if (capability.toolsRequireReasoningNoneFor && new RegExp(capability.toolsRequireReasoningNoneFor, 'i').test(model)) seed.forceReasoningNone = true;
  return seed;
}
