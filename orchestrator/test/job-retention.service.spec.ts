import { JobRetentionService } from '../src/modules/pipeline/job-retention.service';

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_AGE_MS = 2 * 24 * 60 * 60_000;

function fakePrisma(candidates: { id: string }[]) {
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  return {
    job: { findMany: jest.fn().mockResolvedValue(candidates), deleteMany },
    chatMessage: { deleteMany },
    jobEvent: { deleteMany },
    auditEntry: { deleteMany },
    dedupSkipAudit: { deleteMany },
    createdItemMapping: { deleteMany },
    jobSourceFile: { deleteMany },
    jobFigureFile: { deleteMany },
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

  it('a failed transaction is swallowed -- never throws out of sweep()', async () => {
    const prisma = fakePrisma([{ id: 'job-old' }]);
    prisma.$transaction.mockRejectedValueOnce(new Error('connection lost'));
    const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

    await expect(service.sweep()).resolves.toBeUndefined();
  });

  it('batches every eligible job into the SAME transaction, not one per job', async () => {
    const prisma = fakePrisma([{ id: 'job-a' }, { id: 'job-b' }, { id: 'job-c' }]);
    const service = new JobRetentionService(prisma as any, CHECK_INTERVAL_MS, MAX_AGE_MS);

    await service.sweep();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.job.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['job-a', 'job-b', 'job-c'] } } });
  });
});
