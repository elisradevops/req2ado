// What the proxy itself states about a model in its model list (Open WebUI's `GET /api/models`, whose entries carry
// LiteLLM's model info for the models LiteLLM knows). Prod samples: the Claude entries state `mode`,
// `max_input_tokens` and `max_output_tokens`; the GPT-5.6, gpt-chat-latest and gpt-oss entries state none of them.
// The `info.meta.capabilities` block is Open WebUI's own per-model default, identical (all true) for every model,
// including gpt-oss-120b whose vision calls fail: it is kept apart as an unverified claim, never as a fact.

export interface ModelListFacts {
  id: string;
  /** LiteLLM's mode ("chat", ...) when the proxy states it. */
  mode: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  tags: string[];
  /** Tagged "Thinking" by the proxy's administrators: a hint that the model reasons by default. */
  thinkingTagged: boolean;
  /** Open WebUI's capability flags, as claimed. Do not decide behaviour from them. */
  claimedCapabilities: Record<string, boolean>;
  preset: boolean;
  baseModelId: string | null;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

function tagNames(...sources: unknown[]): string[] {
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    const names = source
      .map((tag) => asObject(tag)?.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
    if (names.length > 0) return names;
  }
  return [];
}

/** Null when the entry has no usable id. Never throws. */
export function parseModelListEntry(entry: unknown): ModelListFacts | null {
  const item = asObject(entry);
  if (!item || typeof item.id !== 'string' || item.id.length === 0) return null;
  const info = asObject(item.info);
  const meta = asObject(info?.meta);
  const capabilities = asObject(meta?.capabilities) ?? {};
  const tags = tagNames(item.tags, meta?.tags);
  return {
    id: item.id,
    mode: typeof item.mode === 'string' ? item.mode : null,
    maxInputTokens: positiveInteger(item.max_input_tokens),
    maxOutputTokens: positiveInteger(item.max_output_tokens),
    tags,
    thinkingTagged: tags.some((tag) => tag.toLowerCase() === 'thinking'),
    claimedCapabilities: Object.fromEntries(Object.entries(capabilities).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>,
    preset: item.preset === true,
    baseModelId: typeof info?.base_model_id === 'string' ? info.base_model_id : null,
  };
}
