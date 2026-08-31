import { LlmConfigResolver } from '../src/modules/auth/llm-config.resolver';

describe('LlmConfigResolver', () => {
  it('returns undefined when the user has no vaulted Open WebUI connection', async () => {
    const vault = { get: jest.fn().mockResolvedValue(null) };
    const resolver = new LlmConfigResolver(vault as any);

    const result = await resolver.resolve('user-1');

    expect(result).toBeUndefined();
    expect(vault.get).toHaveBeenCalledWith('user:user-1', 'llm_api_key');
  });

  it('parses the stored JSON into {apiKey, chatModel, visionModel}', async () => {
    const vault = {
      get: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'sk-secret', chatModel: 'qwen2.5:14b', visionModel: 'gemma4:e4b' })),
    };
    const resolver = new LlmConfigResolver(vault as any);

    const result = await resolver.resolve('user-1');

    expect(result).toEqual({ apiKey: 'sk-secret', chatModel: 'qwen2.5:14b', visionModel: 'gemma4:e4b' });
  });

  it('omits visionModel when it was never stored -- callers resolve vision to the chat model in that case', async () => {
    const vault = { get: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'sk-secret', chatModel: 'qwen2.5:14b' })) };
    const resolver = new LlmConfigResolver(vault as any);

    const result = await resolver.resolve('user-1');

    expect(result).toEqual({ apiKey: 'sk-secret', chatModel: 'qwen2.5:14b' });
  });

  it('returns undefined (not a throw) when the stored value is corrupt/non-JSON', async () => {
    const vault = { get: jest.fn().mockResolvedValue('not-valid-json{{{') };
    const resolver = new LlmConfigResolver(vault as any);

    const result = await resolver.resolve('user-1');

    expect(result).toBeUndefined();
  });
});
