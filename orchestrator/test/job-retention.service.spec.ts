import { JobRetentionService } from '../src/modules/pipeline/job-retention.service';

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_AGE_MS = 2 * 24 * 60 * 60_000;

function fakePrisma(candidates: { id: string }[]) {
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  return {
    job: { findMany: jest.fn().mockResolvedValue(candidates), deleteMany },
    chatMessage: { deleteMany },
    jobEvent: { deleteMany },
    auditEntry: { deleteMany, create: jest.fn().mockResolvedValue({}) },
    dedupSkipAudit: { deleteMany },
    createdItemMapping: { deleteMany },
    jobSourceFile: { deleteMany },
    jobFigureFile: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn().mockImplementation((ops: unknown[]) => Promise.all(ops)),
  };
}

describe('JobRetentionService', () => {
  it('deletes an old terminal job and every cascade child in one transaction', async () => {
    const prisma = fakePrisma([{ id: 'job-old' }]);
    const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

    await service.sweep();

    expect(prisma.job.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['succeeded', 'failed', 'rejected', 'cancelled'] }, createdAt: { lt: expect.any(Date) } },
      select: { id: true },
      take: 100,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    for (const table of ['chatMessage', 'jobEvent', 'auditEntry', 'dedupSkipAudit', 'createdItemMapping', 'jobSourceFile', 'jobFigureFile'] as const) {
      expect((prisma as any)[table].deleteMany).toHaveBeenCalledWith({ where: { jobId: { in: ['job-old'] } } });
    }
    expect(prisma.job.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['job-old'] } } });
  });

  it('never queries for pending/running/diff_ready jobs -- only the four terminal statuses', async () => {
    const prisma = fakePrisma([]);
    const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

    await service.sweep();

    const statuses = prisma.job.findMany.mock.calls[0][0].where.status.in;
    expect(statuses).not.toContain('pending');
    expect(statuses).not.toContain('running');
    expect(statuses).not.toContain('diff_ready');
  });

  it('does nothing when no job is old enough -- no transaction opened at all', async () => {
    const prisma = fakePrisma([]);
    const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

    await service.sweep();

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a failed transaction never throws out of sweep()', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const prisma = fakePrisma([{ id: 'job-old' }]);
      prisma.$transaction.mockRejectedValueOnce(new Error('connection lost'));
      const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

      await expect(service.sweep()).resolves.toBeUndefined();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs a failed sweep instead of swallowing it', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const prisma = fakePrisma([{ id: 'job-old' }]);
      prisma.$transaction.mockRejectedValueOnce(new Error('connection lost'));
      const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

      await service.sweep();

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('JobRetentionService'),
        expect.objectContaining({ message: 'connection lost' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('batches every eligible job into the SAME transaction, not one per job', async () => {
    const prisma = fakePrisma([{ id: 'job-a' }, { id: 'job-b' }, { id: 'job-c' }]);
    const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

    await service.sweep();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.job.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['job-a', 'job-b', 'job-c'] } } });
  });

  it('a failing sweep tick (findMany rejects) is logged, never an unhandled rejection -- and the next tick still runs', async () => {
    jest.useFakeTimers();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const prisma = fakePrisma([]);
      prisma.job.findMany.mockRejectedValueOnce(new Error('db stalled'));
      const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('JobRetentionService sweep failed'),
        expect.any(Error),
      );

      await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

      // two queries per tick now (terminal sweep + figure sweep)
      expect(prisma.job.findMany).toHaveBeenCalledTimes(4);
      service.onModuleDestroy();
    } finally {
      consoleError.mockRestore();
      jest.useRealTimers();
    }
  });

  describe('sweepStaleFigureBytes', () => {
    const FIGURE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
    const NOW = new Date('2026-11-09T00:00:00Z').getTime();

    function figurePrisma(staleIds: string[]) {
      const prisma = fakePrisma([]);
      prisma.job.findMany.mockImplementation(async (args: any) =>
        args.where.status === 'diff_ready' ? staleIds.map((id) => ({ id })) : [],
      );
      return prisma;
    }
    const make = (prisma: any) =>
      new JobRetentionService(prisma, CHECK_INTERVAL_MS, MAX_AGE_MS, FIGURE_MAX_AGE_MS);

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
    });
    afterEach(() => jest.useRealTimers());

    it('purges figure bytes of diff_ready jobs older than the figure cutoff and keeps the job row', async () => {
      const prisma = figurePrisma(['job-a']);

      await make(prisma).sweepStaleFigureBytes();

      expect(prisma.job.findMany).toHaveBeenCalledWith({
        where: {
          status: 'diff_ready',
          createdAt: { lt: new Date(NOW - FIGURE_MAX_AGE_MS) },
          figureFiles: { some: {} },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true },
      });
      expect(prisma.jobFigureFile.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-a', job: { status: 'diff_ready' } } });
      expect(prisma.job.deleteMany).not.toHaveBeenCalled();
    });

    it('never purges figures of a diff_ready job younger than the figure cutoff', async () => {
      const prisma = figurePrisma([]);

      await make(prisma).sweepStaleFigureBytes();

      const where = prisma.job.findMany.mock.calls[0][0].where;
      expect(where.createdAt.lt.getTime()).toBe(NOW - FIGURE_MAX_AGE_MS);
      expect(prisma.jobFigureFile.deleteMany).not.toHaveBeenCalled();
      expect(prisma.auditEntry.create).not.toHaveBeenCalled();
    });

    it('bounds each sweep to 20 jobs', async () => {
      const prisma = figurePrisma([]);

      await make(prisma).sweepStaleFigureBytes();

      expect(prisma.job.findMany.mock.calls[0][0].take).toBe(20);
    });

    it('writes one audit entry per purged job', async () => {
      const prisma = figurePrisma(['job-a', 'job-b']);

      await make(prisma).sweepStaleFigureBytes();

      expect(prisma.auditEntry.create).toHaveBeenCalledTimes(2);
      expect(prisma.auditEntry.create).toHaveBeenCalledWith({
        data: {
          jobId: 'job-a',
          message: 'Figure images removed after 30 days without a write; they can no longer be attached.',
        },
      });
      expect(prisma.auditEntry.create).toHaveBeenCalledWith({
        data: { jobId: 'job-b', message: expect.stringContaining('after 30 days') },
      });
    });

    it('one failing job does not stop the others', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const prisma = figurePrisma(['job-a', 'job-b']);
        prisma.$transaction.mockRejectedValueOnce(new Error('boom'));

        await expect(make(prisma).sweepStaleFigureBytes()).resolves.toBeUndefined();

        expect(prisma.jobFigureFile.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-b', job: { status: 'diff_ready' } } });
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining('job-a'),
          expect.objectContaining({ message: 'boom' }),
        );
      } finally {
        consoleError.mockRestore();
      }
    });

    it('runs from the interval tick alongside the terminal sweep', async () => {
      const prisma = figurePrisma(['job-a']);
      const service = make(prisma);

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      service.onModuleDestroy();

      expect(prisma.jobFigureFile.deleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-a', job: { status: 'diff_ready' } } });
    });

    it('does not delete figure rows of a job that is no longer diff_ready', async () => {
      const prisma = figurePrisma(['job-a']);
      // A confirm claimed the job between the findMany and the delete: the guarded delete matches nothing.
      prisma.jobFigureFile.deleteMany.mockImplementation(async (args: any) =>
        args.where.job?.status === 'diff_ready' ? { count: 0 } : { count: 3 },
      );

      await make(prisma).sweepStaleFigureBytes();

      const call = prisma.jobFigureFile.deleteMany.mock.calls[0][0];
      expect(call.where).toEqual({ jobId: 'job-a', job: { status: 'diff_ready' } });
    });

    it('delete and audit run in one transaction', async () => {
      const prisma = figurePrisma(['job-a']);

      await make(prisma).sweepStaleFigureBytes();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
      expect(prisma.auditEntry.create).toHaveBeenCalledTimes(1);
    });

    it('does not touch terminal-status handling', async () => {
      const prisma = figurePrisma(['job-a']);

      await make(prisma).sweepStaleFigureBytes();

      const statuses = prisma.job.findMany.mock.calls.map((c: any) => c[0].where.status);
      expect(statuses).toEqual(['diff_ready']);
    });
  });
});
