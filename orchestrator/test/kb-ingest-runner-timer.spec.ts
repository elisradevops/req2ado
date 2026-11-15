import { KbIngestRunnerTimer } from '../src/modules/kb/kb-ingest-runner-timer';

describe('KbIngestRunnerTimer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function build(runner: Partial<Record<'run' | 'recoverOrphans', jest.Mock>> = {}) {
    const full = { run: jest.fn().mockResolvedValue(undefined), recoverOrphans: jest.fn().mockResolvedValue(undefined), ...runner };
    return { timer: new KbIngestRunnerTimer(full as any, 2_000), runner: full };
  }

  it('first puts back whatever a restart interrupted, then starts ticking', async () => {
    const order: string[] = [];
    const { timer, runner } = build({
      recoverOrphans: jest.fn().mockImplementation(async () => order.push('recover')),
      run: jest.fn().mockImplementation(async () => order.push('run')),
    });

    await timer.onModuleInit();
    expect(runner.run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(order).toEqual(['recover', 'run']);
    timer.onModuleDestroy();
  });

  it('runs on every interval', async () => {
    const { timer, runner } = build();
    await timer.onModuleInit();

    await jest.advanceTimersByTimeAsync(6_000);

    expect(runner.run).toHaveBeenCalledTimes(3);
    timer.onModuleDestroy();
  });

  it('stops when the module is destroyed', async () => {
    const { timer, runner } = build();
    await timer.onModuleInit();
    timer.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('still starts when the recovery fails: a database hiccup at boot must not stop the runner for good', async () => {
    const { timer, runner } = build({ recoverOrphans: jest.fn().mockRejectedValue(new Error('db down')) });

    await expect(timer.onModuleInit()).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(runner.run).toHaveBeenCalledTimes(1);
    timer.onModuleDestroy();
  });
});
