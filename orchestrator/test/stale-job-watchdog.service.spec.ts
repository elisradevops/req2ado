import { StaleJobWatchdogService } from '../src/modules/pipeline/stale-job-watchdog.service';

const CHECK_INTERVAL_MS = 5 * 60_000;
const STALE_THRESHOLD_MS = 60 * 60_000;

describe('StaleJobWatchdogService', () => {
  it('cancels a pending/running job whose most recent JobEvent is past the staleness threshold', async () => {
    const staleJob = { id: 'job-stale', createdAt: new Date(Date.now() - 3 * STALE_THRESHOLD_MS) };
    const prisma = {
      job: { findMany: jest.fn().mockResolvedValue([staleJob]) },
      jobEvent: {
        findFirst: jest.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 2 * STALE_THRESHOLD_MS) }),
      },
    };
    const jobsService = { cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }) };
    const watchdog = new StaleJobWatchdogService(prisma as any, jobsService as any, CHECK_INTERVAL_MS, STALE_THRESHOLD_MS);

    await watchdog.sweep();

    expect(prisma.job.findMany).toHaveBeenCalledWith({ where: { status: { in: ['pending', 'running'] } } });
    expect(jobsService.cancel).toHaveBeenCalledTimes(1);
    const [calledId, reason] = jobsService.cancel.mock.calls[0];
    expect(calledId).toBe('job-stale');
    expect(reason).toContain('Automatically cancelled');
    expect(reason).toContain('60 minutes');
  });

  it('does not touch a job whose most recent JobEvent is recent', async () => {
    const freshJob = { id: 'job-fresh', createdAt: new Date(Date.now() - 3 * STALE_THRESHOLD_MS) };
    const prisma = {
      job: { findMany: jest.fn().mockResolvedValue([freshJob]) },
      jobEvent: { findFirst: jest.fn().mockResolvedValue({ createdAt: new Date() }) },
    };
    const jobsService = { cancel: jest.fn() };
    const watchdog = new StaleJobWatchdogService(prisma as any, jobsService as any, CHECK_INTERVAL_MS, STALE_THRESHOLD_MS);

    await watchdog.sweep();

    expect(jobsService.cancel).not.toHaveBeenCalled();
  });

  it('falls back to the job\'s own createdAt when it has no JobEvent yet', async () => {
    // A job that has just been submitted, before its first narration/stage
    // event has landed -- must still be caught if it never progresses,
    // rather than being permanently exempt for having "no activity to
    // compare against".
    const staleJob = { id: 'job-no-events', createdAt: new Date(Date.now() - 2 * STALE_THRESHOLD_MS) };
    const prisma = {
      job: { findMany: jest.fn().mockResolvedValue([staleJob]) },
      jobEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const jobsService = { cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }) };
    const watchdog = new StaleJobWatchdogService(prisma as any, jobsService as any, CHECK_INTERVAL_MS, STALE_THRESHOLD_MS);

    await watchdog.sweep();

    expect(jobsService.cancel).toHaveBeenCalledWith('job-no-events', expect.stringContaining('Automatically cancelled'));
  });

  it('never aborts the sweep when one job\'s cancel() call fails -- every other candidate still gets checked', async () => {
    const staleJobA = { id: 'job-a', createdAt: new Date(Date.now() - 3 * STALE_THRESHOLD_MS) };
    const staleJobB = { id: 'job-b', createdAt: new Date(Date.now() - 3 * STALE_THRESHOLD_MS) };
    const prisma = {
      job: { findMany: jest.fn().mockResolvedValue([staleJobA, staleJobB]) },
      jobEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const jobsService = {
      cancel: jest.fn().mockRejectedValueOnce(new Error('already transitioned')).mockResolvedValueOnce({ status: 'cancelled' }),
    };
    const watchdog = new StaleJobWatchdogService(prisma as any, jobsService as any, CHECK_INTERVAL_MS, STALE_THRESHOLD_MS);

    await expect(watchdog.sweep()).resolves.toBeUndefined();
    expect(jobsService.cancel).toHaveBeenCalledTimes(2);
  });
});
