import { ChatController } from '../src/modules/chat/chat.controller';

const user = { userId: 'user-1', displayName: 'U' } as never;
const catalog = [
  { id: 'good', name: 'good', vision: false },
  { id: 'persona-bot', name: 'persona-bot', vision: false },
];
const clientFactory = { getClientFor: jest.fn(async () => ({ listSelectableModels: async () => catalog })) } as never;

describe('ChatController.models', () => {
  it('lists the same models the job picker lists: the ones model health has not found failing', async () => {
    const modelHealth = { filterVisible: jest.fn(async (_userId: string, models: { id: string }[]) => models.filter((m) => m.id !== 'persona-bot')) };
    const controller = new ChatController({} as never, {} as never, clientFactory, modelHealth as never);
    expect(await controller.models(user)).toEqual({ models: ['good'] });
    expect(modelHealth.filterVisible).toHaveBeenCalledWith('user-1', catalog);
  });

  it('lists every model when model health is not present (switched off or not wired)', async () => {
    const controller = new ChatController({} as never, {} as never, clientFactory);
    expect(await controller.models(user)).toEqual({ models: ['good', 'persona-bot'] });
  });
});
