import { HealthController } from '../src/modules/health/health.controller';

describe('HealthController', () => {
  it('GET /health returns ok:true without touching Postgres or Redis', () => {
    const prisma = { $queryRaw: jest.fn() };
    const redis = { ping: jest.fn() };
    const controller = new HealthController(prisma as any, redis as any);

    expect(controller.liveness()).toEqual({ ok: true });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it('GET /ready returns ok:true when both Postgres and Redis are reachable', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    const controller = new HealthController(prisma as any, redis as any);

    await expect(controller.readiness()).resolves.toEqual({ ok: true, postgres: true, redis: true });
  });

  it('GET /ready throws a 503 when Postgres is unreachable', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    const controller = new HealthController(prisma as any, redis as any);

    await expect(controller.readiness()).rejects.toMatchObject({
      status: 503,
      response: { ok: false, postgres: false, redis: true },
    });
  });

  it('GET /ready throws a 503 when Redis is unreachable', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const controller = new HealthController(prisma as any, redis as any);

    await expect(controller.readiness()).rejects.toMatchObject({
      status: 503,
      response: { ok: false, postgres: true, redis: false },
    });
  });

  it('GET /ready throws a 503 when Redis ping does not return PONG', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue('WRONG') };
    const controller = new HealthController(prisma as any, redis as any);

    await expect(controller.readiness()).rejects.toMatchObject({ status: 503 });
  });
});
