import { LlmStatusController } from '../src/modules/llm/llm-status.controller';

describe('LlmStatusController', () => {
  it('returns the client\'s reachable health check result', async () => {
    const client = { checkHealth: jest.fn().mockResolvedValue({ status: 'reachable', latencyMs: 42 }) };
    const controller = new LlmStatusController(client as any);

    const result = await controller.getStatus();

    expect(result).toEqual({ status: 'reachable', latencyMs: 42 });
  });

  it('returns unreachable when the client reports so, without throwing', async () => {
    const client = { checkHealth: jest.fn().mockResolvedValue({ status: 'unreachable', latencyMs: 5000 }) };
    const controller = new LlmStatusController(client as any);

    const result = await controller.getStatus();

    expect(result).toEqual({ status: 'unreachable', latencyMs: 5000 });
  });
});
