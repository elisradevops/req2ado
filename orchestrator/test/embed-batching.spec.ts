import {
  ADA_002_V1_LIMITS,
  EMBED_CAPABILITIES,
  EmbedLimitMemory,
  MAX_HALVINGS,
  halveLimits,
  isEmbedSizeRejection,
  planBatches,
  resolveEmbedLimits,
} from '../src/modules/llm/embed-batching';

describe('resolveEmbedLimits', () => {
  it('table matches azure and openai names', () => {
    for (const m of ['text-embedding-3-small', 'azure/text-embedding-3-large', 'Text-Embedding-3-Large']) {
      const l = resolveEmbedLimits(m, {});
      expect(l).toMatchObject({ inputs: 2048, tokensPerInput: 7500, tokensPerRequest: 250000, family: 'openai-text-embedding-3', source: 'table' });
    }
    for (const m of ['text-embedding-ada-002', 'azure/ada-002']) {
      expect(resolveEmbedLimits(m, {})).toMatchObject({ family: 'openai-ada-002', inputs: 2048, tokensPerInput: 7500 });
    }
    expect(resolveEmbedLimits('nomic-embed-text:latest', {})).toMatchObject({ family: 'ollama-embedding', inputs: 64 });
    expect(EMBED_CAPABILITIES.every((c) => c.sources.length > 0 && c.sources.every((s) => s.checked === '2026-11-09'))).toBe(true);
    expect(ADA_002_V1_LIMITS.tokensPerInput).toBe(2046);
  });

  it('opaque deployment name uses baseModel', () => {
    const l = resolveEmbedLimits('emb-prod-01', { baseModel: 'azure/text-embedding-3-large' });
    expect(l).toMatchObject({ family: 'openai-text-embedding-3', source: 'base-model', inputs: 2048 });
  });

  it('unknown model gets the conservative default', () => {
    const l = resolveEmbedLimits('emb-prod-01', {});
    expect(l).toEqual({ inputs: 256, tokensPerInput: 6000, tokensPerRequest: 80000, family: 'default', source: 'default' });
  });

  it('env override beats learned beats table', () => {
    const table = resolveEmbedLimits('text-embedding-3-small', {});
    const learned = resolveEmbedLimits('text-embedding-3-small', { learned: { inputs: 100, tokensPerRequest: 90000 } });
    expect(learned).toMatchObject({ inputs: 100, tokensPerRequest: 90000, tokensPerInput: table.tokensPerInput, source: 'learned' });
    const env = resolveEmbedLimits('text-embedding-3-small', {
      learned: { inputs: 100, tokensPerRequest: 90000 },
      env: { maxInputs: 10 },
    });
    expect(env).toMatchObject({ inputs: 10, tokensPerRequest: 90000, source: 'env' });
    const env2 = resolveEmbedLimits('text-embedding-3-small', { learned: { tokensPerRequest: 90000 }, env: { maxTokens: 5000 } });
    expect(env2.tokensPerRequest).toBe(5000);
  });

  it('maxInputTokensFromInfo lowers the per-input cap', () => {
    expect(resolveEmbedLimits('text-embedding-3-small', { maxInputTokensFromInfo: 2000 }).tokensPerInput).toBe(2000);
    expect(resolveEmbedLimits('text-embedding-3-small', { maxInputTokensFromInfo: 99999 }).tokensPerInput).toBe(7500);
  });

  it('non exact tokenizers get a 0.8 margin', () => {
    const l = resolveEmbedLimits('mxbai-embed-large', {});
    expect(l.tokensPerInput).toBe(Math.floor(512 * 0.8));
    expect(l.tokensPerRequest).toBe(25600);
    expect(l.inputs).toBe(64);
    expect(resolveEmbedLimits('text-embedding-3-small', {}).tokensPerInput).toBe(7500);
  });
});

describe('planBatches', () => {
  const limits = { inputs: 2048, tokensPerInput: 7500, tokensPerRequest: 250000, family: 'x', source: 'table' as const };

  it('splits 2049 items into 2048 + 1', () => {
    expect(planBatches(new Array(2049).fill(1), limits)).toEqual([[0, 2048], [2048, 2049]]);
  });

  it('keeps summed tokens under the request cap and preserves order', () => {
    const counts = [40, 40, 40, 10, 90, 5, 5, 60];
    const batches = planBatches(counts, { ...limits, tokensPerRequest: 100 });
    expect(batches).toEqual([[0, 2], [2, 4], [4, 7], [7, 8]]);
    for (const [s, e] of batches) expect(counts.slice(s, e).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
    expect(planBatches([], limits)).toEqual([]);
  });

  it('one oversized item gets its own batch', () => {
    expect(planBatches([5, 500, 5], { ...limits, tokensPerRequest: 100 })).toEqual([[0, 1], [1, 2], [2, 3]]);
  });
});

describe('rejection handling', () => {
  const base = { inputs: 5, tokensPerInput: 100, tokensPerRequest: 7, family: 'x', source: 'table' as const };

  it('halveLimits floors at 1', () => {
    expect(halveLimits(base)).toMatchObject({ inputs: 2, tokensPerRequest: 3, tokensPerInput: 100 });
    expect(halveLimits({ ...base, inputs: 1, tokensPerRequest: 1 })).toMatchObject({ inputs: 1, tokensPerRequest: 1 });
    expect(MAX_HALVINGS).toBe(11);
  });

  it('isEmbedSizeRejection recognises azure and openai bodies and ignores 401/429/500', () => {
    expect(isEmbedSizeRejection(400, "'$.input' is invalid. Please check the API reference: too many inputs, array too long. Maximum 2048")).toBe(true);
    expect(isEmbedSizeRejection(400, 'Invalid \'input\': array too long. Expected an array with maximum length 2048')).toBe(true);
    expect(isEmbedSizeRejection(400, 'Requested 312,000 tokens, max 300,000 tokens per request')).toBe(true);
    expect(isEmbedSizeRejection(413, 'Payload Too Large')).toBe(true);
    expect(isEmbedSizeRejection(400, "This model's maximum context length is 8192 tokens")).toBe(true);
    expect(isEmbedSizeRejection(400, 'invalid api version')).toBe(false);
    for (const s of [401, 429, 500]) expect(isEmbedSizeRejection(s, 'too many inputs')).toBe(false);
  });

  it('EmbedLimitMemory remembers per model', () => {
    const m = new EmbedLimitMemory();
    expect(m.get('a')).toBeUndefined();
    m.remember('a', { inputs: 8 });
    m.remember('a', { tokensPerRequest: 100 });
    m.remember('b', { inputs: 1 });
    expect(m.get('a')).toEqual({ inputs: 8, tokensPerRequest: 100 });
    expect(m.get('b')).toEqual({ inputs: 1 });
  });
});
