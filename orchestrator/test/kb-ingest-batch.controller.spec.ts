import { NotFoundException } from '@nestjs/common';
import { KbIngestBatchController } from '../src/modules/kb/kb-ingest-batch.controller';
import type { SessionUser } from '../src/modules/auth/session.service';

const USER: SessionUser = { userId: 'user-1', displayName: 'Test User' };
const VIEW = { id: 'batch-1' } as any;

function build(overrides: Record<string, jest.Mock> = {}) {
  const service = {
    create: jest.fn().mockResolvedValue(VIEW),
    list: jest.fn().mockResolvedValue([VIEW]),
    get: jest.fn().mockResolvedValue(VIEW),
    cancel: jest.fn().mockResolvedValue(VIEW),
    retryFailed: jest.fn().mockResolvedValue(VIEW),
    resume: jest.fn().mockResolvedValue(VIEW),
    ...overrides,
  };
  return { controller: new KbIngestBatchController(service as any), service };
}

describe('KbIngestBatchController', () => {
  it('create() hands the body to the service under the session user, never a user id from the request', async () => {
    const { controller, service } = build();
    const body = { driveId: 'd', items: [] };

    expect(await controller.create(USER, body)).toBe(VIEW);
    expect(service.create).toHaveBeenCalledWith('user-1', body);
  });

  it('list() passes active and limit through, parsed', async () => {
    const { controller, service } = build();

    await controller.list(USER, 'true', '5');
    await controller.list(USER, undefined, undefined);
    await controller.list(USER, 'false', 'not-a-number');

    expect(service.list).toHaveBeenNthCalledWith(1, 'user-1', { active: true, limit: 5 });
    expect(service.list).toHaveBeenNthCalledWith(2, 'user-1', { active: false, limit: undefined });
    expect(service.list).toHaveBeenNthCalledWith(3, 'user-1', { active: false, limit: undefined });
  });

  it.each(['get', 'cancel', 'retryFailed', 'resume'] as const)('%s() answers 404 when the service finds no such batch for this user', async (method) => {
    const { controller } = build({ [method === 'get' ? 'get' : method]: jest.fn().mockResolvedValue(null) });

    await expect(controller[method](USER, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['get', 'get'],
    ['cancel', 'cancel'],
    ['retryFailed', 'retryFailed'],
    ['resume', 'resume'],
  ] as const)('%s() returns the service result for the session user', async (method, serviceMethod) => {
    const { controller, service } = build();

    expect(await controller[method](USER, 'batch-1')).toBe(VIEW);
    expect(service[serviceMethod]).toHaveBeenCalledWith('user-1', 'batch-1');
  });
});
