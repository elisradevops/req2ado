import { BadRequestException } from '@nestjs/common';
import { LlmConnectionController } from '../src/modules/llm/llm-connection.controller';

const USER = { userId: 'user-1', displayName: 'User One' } as any;
const CATALOG = [
  { id: 'qwen2.5:14b', name: 'qwen2.5:14b', vision: false },
  { id: 'gemma4:e4b', name: 'gemma4:e4b', vision: true },
];

function makeController(overrides: {
  vault?: any;
  llmConfigResolver?: any;
  clientFactory?: any;
} = {}) {
  const vault = overrides.vault ?? { set: jest.fn() };
  const llmConfigResolver = overrides.llmConfigResolver ?? { resolve: jest.fn().mockResolvedValue(undefined) };
  const clientFactory = overrides.clientFactory ?? {
    listModelsForToken: jest.fn().mockResolvedValue(CATALOG),
    invalidate: jest.fn(),
  };
  const controller = new LlmConnectionController(vault, llmConfigResolver, clientFactory);
  return { controller, vault, llmConfigResolver, clientFactory };
}

describe('LlmConnectionController', () => {
  describe('GET /llm/connection', () => {
    it('returns configured: false when the user has no vaulted profile', async () => {
      const { controller } = makeController();
      const result = await controller.getConnection(USER);
      expect(result).toEqual({ configured: false });
    });

    it('returns the non-secret fields when a profile exists, and NEVER the apiKey', async () => {
      const { controller } = makeController({
        llmConfigResolver: { resolve: jest.fn().mockResolvedValue({ apiKey: 'sk-secret', chatModel: 'qwen2.5:14b', visionModel: 'gemma4:e4b' }) },
      });
      const result = await controller.getConnection(USER);
      expect(result).toEqual({ configured: true, chatModel: 'qwen2.5:14b', visionModel: 'gemma4:e4b' });
      expect(result).not.toHaveProperty('apiKey');
    });

    it('omits visionModel when only a chat model is stored', async () => {
      const { controller } = makeController({
        llmConfigResolver: { resolve: jest.fn().mockResolvedValue({ apiKey: 'sk-secret', chatModel: 'qwen2.5:14b' }) },
      });
      const result = await controller.getConnection(USER);
      expect(result).toEqual({ configured: true, chatModel: 'qwen2.5:14b' });
    });
  });

  describe('GET /llm/connection/models', () => {
    it('previews a candidate token via the query param without touching the vault', async () => {
      const { controller, clientFactory, llmConfigResolver } = makeController();
      const result = await controller.getModels(USER, 'candidate-token');
      expect(clientFactory.listModelsForToken).toHaveBeenCalledWith('candidate-token');
      expect(llmConfigResolver.resolve).not.toHaveBeenCalled();
      expect(result).toEqual({ models: CATALOG });
    });

    it("lists models for the caller's already-stored token when no query token is given", async () => {
      const { controller, clientFactory } = makeController({
        llmConfigResolver: { resolve: jest.fn().mockResolvedValue({ apiKey: 'sk-stored', chatModel: 'qwen2.5:14b' }) },
      });
      const result = await controller.getModels(USER, undefined);
      expect(clientFactory.listModelsForToken).toHaveBeenCalledWith('sk-stored');
      expect(result).toEqual({ models: CATALOG });
    });

    it('throws BadRequestException when no token is given and none is stored yet', async () => {
      const { controller } = makeController();
      await expect(controller.getModels(USER, undefined)).rejects.toThrow(BadRequestException);
    });
  });

  describe('POST /llm/connection', () => {
    it('validates the token live before storing, and rejects with 400 on an invalid body', async () => {
      const { controller } = makeController();
      await expect(controller.setConnection(USER, {})).rejects.toThrow(BadRequestException);
    });

    it('rejects with 400 (and never stores) when the token fails live validation', async () => {
      const clientFactory = { listModelsForToken: jest.fn().mockRejectedValue(new Error('401 unauthorized')), invalidate: jest.fn() };
      const { controller, vault } = makeController({ clientFactory });
      await expect(controller.setConnection(USER, { apiKey: 'bad-token', chatModel: 'qwen2.5:14b' })).rejects.toThrow(
        BadRequestException,
      );
      expect(vault.set).not.toHaveBeenCalled();
    });

    it('rejects with 400 when chatModel is not in the validated catalog', async () => {
      const { controller, vault } = makeController();
      await expect(controller.setConnection(USER, { apiKey: 'sk-token', chatModel: 'not-a-real-model' })).rejects.toThrow(
        BadRequestException,
      );
      expect(vault.set).not.toHaveBeenCalled();
    });

    it('rejects with 400 when visionModel is not in the validated catalog', async () => {
      const { controller, vault } = makeController();
      await expect(
        controller.setConnection(USER, { apiKey: 'sk-token', chatModel: 'qwen2.5:14b', visionModel: 'not-a-real-model' }),
      ).rejects.toThrow(BadRequestException);
      expect(vault.set).not.toHaveBeenCalled();
    });

    it('stores the validated profile and invalidates the cached client on success', async () => {
      const { controller, vault, clientFactory } = makeController();
      const result = await controller.setConnection(USER, { apiKey: 'sk-token', chatModel: 'qwen2.5:14b', visionModel: 'gemma4:e4b' });

      expect(vault.set).toHaveBeenCalledWith(
        'user:user-1',
        'llm_api_key',
        JSON.stringify({ apiKey: 'sk-token', chatModel: 'qwen2.5:14b', visionModel: 'gemma4:e4b' }),
      );
      expect(clientFactory.invalidate).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ ok: true });
    });

    it('stores no visionModel field when omitted -- callers resolve vision to the chat model in that case', async () => {
      const { controller, vault } = makeController();
      await controller.setConnection(USER, { apiKey: 'sk-token', chatModel: 'qwen2.5:14b' });

      expect(vault.set).toHaveBeenCalledWith('user:user-1', 'llm_api_key', JSON.stringify({ apiKey: 'sk-token', chatModel: 'qwen2.5:14b' }));
    });
  });
});
