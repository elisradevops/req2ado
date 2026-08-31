import { LlmStatusController } from '../src/modules/llm/llm-status.controller';

const USER: any = { userId: 'user-1', displayName: 'User One' };

describe('LlmStatusController', () => {
  it("returns the client's reachable health check result", async () => {
    const client = { checkHealth: jest.fn().mockResolvedValue({ status: 'reachable', latencyMs: 42 }) };
    const clientFactory = { getClientFor: jest.fn().mockResolvedValue(client) };
    const controller = new LlmStatusController(clientFactory as any);

    const result = await controller.getStatus(USER);

    expect(result).toEqual({ status: 'reachable', latencyMs: 42 });
  });

  it('returns unreachable when the client reports so, without throwing', async () => {
    const client = { checkHealth: jest.fn().mockResolvedValue({ status: 'unreachable', latencyMs: 5000 }) };
    const clientFactory = { getClientFor: jest.fn().mockResolvedValue(client) };
    const controller = new LlmStatusController(clientFactory as any);

    const result = await controller.getStatus(USER);

    expect(result).toEqual({ status: 'unreachable', latencyMs: 5000 });
  });

  it('returns not_configured (never throws) when the user has no Open WebUI connection yet', async () => {
    const clientFactory = { getClientFor: jest.fn().mockRejectedValue(new Error('no profile')) };
    const controller = new LlmStatusController(clientFactory as any);

    const result = await controller.getStatus(USER);

    expect(result).toEqual({ status: 'not_configured', latencyMs: null });
  });
});
