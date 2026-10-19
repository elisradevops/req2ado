import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseModelListEntry } from '../src/modules/llm/model-list-entry';

const load = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures/openwebui-models', `${name}.json`), 'utf8'));

describe('parseModelListEntry (what the proxy states about a model in its own list)', () => {
  it('reads the limits and mode the proxy states for a Claude model', () => {
    expect(parseModelListEntry(load('claude-opus-4-8'))).toMatchObject({
      id: 'claude-opus-4-8',
      mode: 'chat',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      thinkingTagged: true,
    });
    expect(parseModelListEntry(load('claude-sonnet-4-6'))).toMatchObject({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
      thinkingTagged: false,
      tags: ['Balanced & Chat'],
    });
  });

  it('states no limits for the GPT and gpt-oss aliases, so they must come from the family table', () => {
    for (const name of ['OpenAI_gpt-5.6-terra', 'OpenAI_gpt-chat-latest', 'OpenAI_gpt-oss-120b']) {
      expect(parseModelListEntry(load(name))).toMatchObject({ mode: null, maxInputTokens: null, maxOutputTokens: null });
    }
  });

  it('keeps the proxy\'s capability claims separate from facts: every model claims vision, gpt-oss included', () => {
    const oss = parseModelListEntry(load('OpenAI_gpt-oss-120b'))!;
    expect(oss.claimedCapabilities.vision).toBe(true); // proven wrong in prod: vision fails on gpt-oss-120b
    expect(oss.tags).toEqual([]);
  });

  it('reads the tags case-insensitively for the thinking hint', () => {
    expect(parseModelListEntry({ id: 'm', tags: [{ name: 'THINKING' }] })?.thinkingTagged).toBe(true);
    expect(parseModelListEntry({ id: 'm', info: { meta: { tags: [{ name: 'thinking' }] } } })?.thinkingTagged).toBe(true);
  });

  it('survives missing and malformed fields without throwing', () => {
    expect(parseModelListEntry({ id: 'x', max_input_tokens: 'lots', max_output_tokens: -5 })).toMatchObject({
      id: 'x', maxInputTokens: null, maxOutputTokens: null, tags: [], claimedCapabilities: {},
    });
    expect(parseModelListEntry(null)).toBeNull();
    expect(parseModelListEntry({})).toBeNull();
    expect(parseModelListEntry({ id: 42 })).toBeNull();
  });

  it('flags presets and derived models', () => {
    expect(parseModelListEntry({ id: 'p', preset: true })).toMatchObject({ preset: true });
    expect(parseModelListEntry({ id: 'd', info: { base_model_id: 'base' } })).toMatchObject({ baseModelId: 'base' });
  });
});
