import { OpenWebUiClientFactory, type OpenWebUiGlobalConfig } from '../src/modules/llm/openwebui-client.factory';

const GLOBAL_CONFIG: OpenWebUiGlobalConfig = {
  LLM_BASE_URL: 'http://openwebui.internal/api/v1',
  LLM_TRUSTED_LOCAL: false,
  EMBED_TRANSPORT: 'ollama',
  EMBED_BASE_URL: undefined,
  EMBED_MODEL: 'nomic-embed-text',
  EMBED_PATH: '/api/embed',
  SHOW_PATH: '/api/show',
  FILES_UPLOAD_PATH: '/api/v1/files/',
  FILES_STATUS_PATH: '/api/v1/files',
  LLM_REQUEST_TIMEOUT_MS: 60_000,
};

describe('OpenWebUiClientFactory', () => {
  it('resolves a client built from the vaulted profile', async () => {
    const llmConfigResolver = {
      resolve: jest.fn().mockResolvedValue({ apiKey: 'sk-user-1', chatModel: 'qwen2.5:14b', visionModel: 'gemma4:e4b' }),
    };
    const factory = new OpenWebUiClientFactory(GLOBAL_CONFIG, llmConfigResolver as any);

    const client = await factory.getClientFor('user-1');

    expect(llmConfigResolver.resolve).toHaveBeenCalledWith('user-1');
    expect(client.chatModel).toBe('qwen2.5:14b');
  });

  it('throws when the user has no vaulted profile -- hard-fail, no shared/global fallback credential', async () => {
    const llmConfigResolver = { resolve: jest.fn().mockResolvedValue(undefined) };
    const factory = new OpenWebUiClientFactory(GLOBAL_CONFIG, llmConfigResolver as any);

    await expect(factory.getClientFor('user-1')).rejects.toThrow(/no Open WebUI connection configured/i);
  });

  // The single most important test in this file: OpenWebUiClientFactory
  // replaces a process-lifetime singleton OpenWebUiClient specifically to
  // close a credential-leak hazard (see the factory's own doc comment) --
  // two concurrent resolutions for two DIFFERENT users must each get a
  // client built from THEIR OWN profile, never a shared/cross-contaminated
  // one, even when both calls are in flight at the same time.
  it('resolves two concurrent calls for different users to two distinct, correctly-scoped clients', async () => {
    const profiles: Record<string, { apiKey: string; chatModel: string }> = {
      'user-a': { apiKey: 'sk-a', chatModel: 'model-a' },
      'user-b': { apiKey: 'sk-b', chatModel: 'model-b' },
    };
    const llmConfigResolver = {
      resolve: jest.fn((userId: string) => Promise.resolve(profiles[userId])),
    };
    const factory = new OpenWebUiClientFactory(GLOBAL_CONFIG, llmConfigResolver as any);

    const [clientA, clientB] = await Promise.all([factory.getClientFor('user-a'), factory.getClientFor('user-b')]);

    expect(clientA.chatModel).toBe('model-a');
    expect(clientB.chatModel).toBe('model-b');
    expect(clientA).not.toBe(clientB);
  });

  it('caches the resolved client per user -- a second call for the same user does not re-hit the resolver', async () => {
    const llmConfigResolver = { resolve: jest.fn().mockResolvedValue({ apiKey: 'sk-user-1', chatModel: 'qwen2.5:14b' }) };
    const factory = new OpenWebUiClientFactory(GLOBAL_CONFIG, llmConfigResolver as any);

    const first = await factory.getClientFor('user-1');
    const second = await factory.getClientFor('user-1');

    expect(first).toBe(second);
    expect(llmConfigResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('invalidate() clears the cache so the next call re-resolves from the vault (picks up a rotated token/model)', async () => {
    const llmConfigResolver = { resolve: jest.fn().mockResolvedValue({ apiKey: 'sk-old', chatModel: 'old-model' }) };
    const factory = new OpenWebUiClientFactory(GLOBAL_CONFIG, llmConfigResolver as any);

    const before = await factory.getClientFor('user-1');
    factory.invalidate('user-1');
    llmConfigResolver.resolve.mockResolvedValue({ apiKey: 'sk-new', chatModel: 'new-model' });
    const after = await factory.getClientFor('user-1');

    expect(before).not.toBe(after);
    expect(after.chatModel).toBe('new-model');
    expect(llmConfigResolver.resolve).toHaveBeenCalledTimes(2);
  });

  it('listModelsForToken builds a throwaway (uncached) client and lists models for that exact token', async () => {
    const llmConfigResolver = { resolve: jest.fn() };
    const factory = new OpenWebUiClientFactory(GLOBAL_CONFIG, llmConfigResolver as any);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-x', name: 'Model X', preset: false, info: { meta: { capabilities: { vision: false } } } }] }),
    } as Response);

    const models = await factory.listModelsForToken('sk-candidate-token');

    expect(models).toEqual([{ id: 'model-x', name: 'Model X', vision: false }]);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/models'),
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-candidate-token' } }),
    );
    // Never touches the vault -- a candidate token being previewed isn't
    // stored/resolved yet.
    expect(llmConfigResolver.resolve).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
