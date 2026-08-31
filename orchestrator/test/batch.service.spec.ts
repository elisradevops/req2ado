import { BatchService } from '../src/modules/batch/batch.service';

// A single fake object plays BOTH the top-level PrismaClient and the `tx`
// handle inside $transaction's interactive-callback form -- simplest
// faithful double for how BatchService actually calls it (transaction
// bodies read/write the same model accessors as the top-level client).
function makePrisma() {
  const prisma: any = {
    jobBatch: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    jobBatchFile: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
    },
    jobBatchFileBlob: {
      create: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    job: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    auditEntry: { create: jest.fn() },
    $transaction: jest.fn((arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => Promise<unknown>)(prisma);
    }),
  };
  return prisma;
}

function makeFile(overrides: Partial<{ buffer: Buffer; filename: string }> = {}) {
  return { buffer: Buffer.from('hello world'), filename: 'spec.txt', ...overrides };
}

describe('BatchService.submitBatch', () => {
  it('creates one JobBatch + one JobBatchFile + one JobBatchFileBlob per accepted file', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.create.mockResolvedValue({ id: 'batch-1' });
    prisma.jobBatchFile.create
      .mockResolvedValueOnce({ id: 'file-0' })
      .mockResolvedValueOnce({ id: 'file-1' });
    const jobsService = { submit: jest.fn() };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);
    jest.spyOn(service, 'pumpOnce').mockResolvedValue({ submitted: 0, failed: 0 });

    const result = await service.submitBatch({
      userId: 'user-1',
      areaPath: 'Project\\Area1',
      mode: 'baseline',
      files: [makeFile({ filename: 'a.txt' }), makeFile({ filename: 'b.txt' })],
    });

    expect(result).toEqual({ batchId: 'batch-1', filesAccepted: 2, filesRejected: 0 });
    expect(prisma.jobBatch.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        areaPath: 'Project\\Area1',
        adoProject: null,
        mode: 'baseline',
        state: null,
        iterationPath: null,
        model: null,
      },
    });
    expect(prisma.jobBatchFile.create).toHaveBeenCalledTimes(2);
    expect(prisma.jobBatchFileBlob.create).toHaveBeenCalledTimes(2);
    expect(prisma.jobBatchFileBlob.create).toHaveBeenCalledWith({
      data: { batchFileId: 'file-0', bytes: expect.any(Buffer) },
    });
  });

  it('marks a bad-extension file invalid without rejecting its siblings', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.create.mockResolvedValue({ id: 'batch-1' });
    prisma.jobBatchFile.create.mockResolvedValue({ id: 'file-x' });
    const jobsService = { submit: jest.fn() };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);
    jest.spyOn(service, 'pumpOnce').mockResolvedValue({ submitted: 0, failed: 0 });

    const result = await service.submitBatch({
      userId: 'user-1',
      areaPath: 'Project\\Area1',
      mode: 'baseline',
      files: [makeFile({ filename: 'good.txt' }), makeFile({ filename: 'malware.exe' })],
    });

    expect(result).toEqual({ batchId: 'batch-1', filesAccepted: 1, filesRejected: 1 });
    const invalidCreateCall = prisma.jobBatchFile.create.mock.calls.find((c: any[]) => c[0].data.filename === 'malware.exe');
    expect(invalidCreateCall[0].data.status).toBe('invalid');
    expect(invalidCreateCall[0].data.error).toMatch(/unsupported file type/i);
    // Only the accepted file gets a blob -- the rejected one never had its
    // bytes persisted at all.
    expect(prisma.jobBatchFileBlob.create).toHaveBeenCalledTimes(1);
  });

  it('marks an oversized file invalid without rejecting its siblings', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.create.mockResolvedValue({ id: 'batch-1' });
    prisma.jobBatchFile.create.mockResolvedValue({ id: 'file-x' });
    const jobsService = { submit: jest.fn() };
    const service = new BatchService(prisma, jobsService as any, 10, 2, 5 * 60_000); // 10-byte cap

    const result = await service.submitBatch({
      userId: 'user-1',
      areaPath: 'Project\\Area1',
      mode: 'baseline',
      files: [makeFile({ filename: 'small.txt', buffer: Buffer.from('x') }), makeFile({ filename: 'big.txt' })],
    });
    jest.spyOn(service, 'pumpOnce').mockResolvedValue({ submitted: 0, failed: 0 });

    expect(result.filesAccepted).toBe(1);
    expect(result.filesRejected).toBe(1);
    const invalidCall = prisma.jobBatchFile.create.mock.calls.find((c: any[]) => c[0].data.filename === 'big.txt');
    expect(invalidCall[0].data.status).toBe('invalid');
    expect(invalidCall[0].data.error).toMatch(/exceeds the .*upload limit/i);
  });

  it('throws BadRequestException when every file in the batch is rejected', async () => {
    const prisma = makePrisma();
    const jobsService = { submit: jest.fn() };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    await expect(
      service.submitBatch({
        userId: 'user-1',
        areaPath: 'Project\\Area1',
        mode: 'baseline',
        files: [makeFile({ filename: 'malware.exe' })],
      }),
    ).rejects.toThrow(/no acceptable files/i);
    expect(prisma.jobBatch.create).not.toHaveBeenCalled();
  });

  it('calls pumpOnce after creating the batch so an immediately-submittable batch is enqueued inline', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.create.mockResolvedValue({ id: 'batch-1' });
    prisma.jobBatchFile.create.mockResolvedValue({ id: 'file-0' });
    const jobsService = { submit: jest.fn() };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);
    const pumpSpy = jest.spyOn(service, 'pumpOnce').mockResolvedValue({ submitted: 1, failed: 0 });

    await service.submitBatch({
      userId: 'user-1',
      areaPath: 'Project\\Area1',
      mode: 'baseline',
      files: [makeFile()],
    });

    expect(pumpSpy).toHaveBeenCalledTimes(1);
  });
});

describe('BatchService.pumpOnce', () => {
  function makeQueuedFile(overrides: Partial<any> = {}) {
    return {
      id: 'file-1',
      batchId: 'batch-1',
      ordinal: 0,
      filename: 'a.txt',
      sizeBytes: 11,
      sourceHash: 'hash-a',
      status: 'queued',
      error: null,
      jobId: null,
      claimedAt: null,
      submittedAt: null,
      createdAt: new Date('2026-08-25T00:00:00Z'),
      batch: {
        id: 'batch-1',
        userId: 'user-1',
        areaPath: 'Project\\Area1',
        mode: 'baseline',
        state: null,
        iterationPath: null,
        model: null,
      },
      ...overrides,
    };
  }

  it('submits every queued BASELINE file in one tick (no throttle applies)', async () => {
    const prisma = makePrisma();
    const files = [makeQueuedFile({ id: 'f1', ordinal: 0 }), makeQueuedFile({ id: 'f2', ordinal: 1 })];
    prisma.jobBatchFile.findMany.mockResolvedValue(files);
    prisma.jobBatchFile.updateMany.mockResolvedValue({ count: 1 }); // the optimistic claim always "wins" in this test
    prisma.jobBatchFileBlob.findUnique.mockResolvedValue({ bytes: Buffer.from('hello') });
    const jobsService = { submit: jest.fn().mockResolvedValue({ jobId: 'job-x' }) };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.pumpOnce();

    expect(result).toEqual({ submitted: 2, failed: 0 });
    expect(jobsService.submit).toHaveBeenCalledTimes(2);
    expect(jobsService.submit).toHaveBeenCalledWith(expect.objectContaining({ batchId: 'batch-1', mode: 'baseline' }));
  });

  it('submits only cap-minus-active SURVEY files and leaves the rest queued', async () => {
    const prisma = makePrisma();
    prisma.job.count.mockResolvedValue(1); // one already active SURVEY job, batchSurveyConcurrency=2 -> 1 slot free
    const files = [
      makeQueuedFile({ id: 'f1', ordinal: 0, batch: { ...makeQueuedFile().batch, mode: 'survey' } }),
      makeQueuedFile({ id: 'f2', ordinal: 1, batch: { ...makeQueuedFile().batch, mode: 'survey' } }),
    ];
    prisma.jobBatchFile.findMany.mockResolvedValue(files);
    prisma.jobBatchFile.updateMany.mockResolvedValue({ count: 1 });
    prisma.jobBatchFileBlob.findUnique.mockResolvedValue({ bytes: Buffer.from('hello') });
    const jobsService = { submit: jest.fn().mockResolvedValue({ jobId: 'job-x' }) };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.pumpOnce();

    expect(result).toEqual({ submitted: 1, failed: 0 });
    expect(jobsService.submit).toHaveBeenCalledTimes(1);
  });

  it('computes the SURVEY slot count globally, not per batch', async () => {
    const prisma = makePrisma();
    // 2 already-active SURVEY jobs across (unspecified) batches, cap is 2 -> 0 slots free.
    prisma.job.count.mockResolvedValue(2);
    const files = [makeQueuedFile({ id: 'f1', batch: { ...makeQueuedFile().batch, mode: 'survey' } })];
    prisma.jobBatchFile.findMany.mockResolvedValue(files);
    const jobsService = { submit: jest.fn() };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.pumpOnce();

    expect(result).toEqual({ submitted: 0, failed: 0 });
    expect(jobsService.submit).not.toHaveBeenCalled();
    expect(prisma.job.count).toHaveBeenCalledWith({
      where: { batchId: { not: null }, mode: 'survey', status: { in: ['pending', 'running'] } },
    });
  });

  it("does not count a batch job sitting at diff_ready or writing toward the SURVEY slot cap", async () => {
    const prisma = makePrisma();
    prisma.job.count.mockResolvedValue(0); // the where-clause itself excludes diff_ready/writing -- asserted below
    const service = new BatchService(prisma, { submit: jest.fn() } as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    await service.pumpOnce();

    const whereArg = prisma.job.count.mock.calls[0][0].where;
    expect(whereArg.status.in).not.toContain('diff_ready');
    expect(whereArg.status.in).not.toContain('writing');
  });

  it('marks a file submit_failed when JobsService.submit throws, without blocking sibling submissions', async () => {
    const prisma = makePrisma();
    const files = [makeQueuedFile({ id: 'f1', ordinal: 0 }), makeQueuedFile({ id: 'f2', ordinal: 1 })];
    prisma.jobBatchFile.findMany.mockResolvedValue(files);
    prisma.jobBatchFile.updateMany.mockResolvedValue({ count: 1 });
    prisma.jobBatchFileBlob.findUnique.mockResolvedValue({ bytes: Buffer.from('hello') });
    const jobsService = {
      submit: jest.fn().mockRejectedValueOnce(new Error('ADO unreachable')).mockResolvedValueOnce({ jobId: 'job-ok' }),
    };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.pumpOnce();

    expect(result).toEqual({ submitted: 1, failed: 1 });
    expect(prisma.jobBatchFile.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { status: 'submit_failed', error: 'ADO unreachable' },
    });
  });

  it('skips a file whose optimistic claim loses the race (updateMany matched 0 rows)', async () => {
    const prisma = makePrisma();
    const files = [makeQueuedFile({ id: 'f1' })];
    prisma.jobBatchFile.findMany.mockResolvedValue(files);
    prisma.jobBatchFile.updateMany.mockResolvedValue({ count: 0 }); // another tick already claimed it
    const jobsService = { submit: jest.fn() };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.pumpOnce();

    expect(result).toEqual({ submitted: 0, failed: 0 });
    expect(jobsService.submit).not.toHaveBeenCalled();
  });

  it('reclaims a file stuck in submitting past BATCH_SUBMIT_STUCK_MS back to queued', async () => {
    const prisma = makePrisma();
    prisma.jobBatchFile.findMany.mockResolvedValue([]);
    const service = new BatchService(prisma, { submit: jest.fn() } as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    await service.pumpOnce();

    expect(prisma.jobBatchFile.updateMany).toHaveBeenCalledWith({
      where: { status: 'submitting', claimedAt: { lt: expect.any(Date) } },
      data: { status: 'queued', claimedAt: null },
    });
  });

  it('deletes the blob on a successful submit and writes an AuditEntry on the new job', async () => {
    const prisma = makePrisma();
    prisma.jobBatchFile.findMany.mockResolvedValue([makeQueuedFile({ id: 'f1' })]);
    prisma.jobBatchFile.updateMany.mockResolvedValue({ count: 1 });
    prisma.jobBatchFileBlob.findUnique.mockResolvedValue({ bytes: Buffer.from('hello') });
    const jobsService = { submit: jest.fn().mockResolvedValue({ jobId: 'job-x' }) };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    await service.pumpOnce();

    expect(prisma.jobBatchFileBlob.delete).toHaveBeenCalledWith({ where: { batchFileId: 'f1' } });
    expect(prisma.auditEntry.create).toHaveBeenCalledWith({
      data: { jobId: 'job-x', message: expect.stringContaining('Submitted from batch batch-1') },
    });
  });

  it('retains the blob when submit fails (no re-upload needed for a future retry)', async () => {
    const prisma = makePrisma();
    prisma.jobBatchFile.findMany.mockResolvedValue([makeQueuedFile({ id: 'f1' })]);
    prisma.jobBatchFile.updateMany.mockResolvedValue({ count: 1 });
    prisma.jobBatchFileBlob.findUnique.mockResolvedValue({ bytes: Buffer.from('hello') });
    const jobsService = { submit: jest.fn().mockRejectedValue(new Error('boom')) };
    const service = new BatchService(prisma, jobsService as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    await service.pumpOnce();

    expect(prisma.jobBatchFileBlob.delete).not.toHaveBeenCalled();
  });

  it('returns zero counts and never throws when a tick fails entirely (e.g. a DB error)', async () => {
    const prisma = makePrisma();
    prisma.jobBatchFile.updateMany.mockRejectedValue(new Error('connection refused'));
    const service = new BatchService(prisma, { submit: jest.fn() } as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    await expect(service.pumpOnce()).resolves.toEqual({ submitted: 0, failed: 0 });
  });
});

function makeBatchFile(overrides: Partial<any> = {}) {
  return {
    id: 'file-1',
    batchId: 'batch-1',
    ordinal: 0,
    filename: 'a.txt',
    sizeBytes: 11,
    sourceHash: 'hash-a',
    status: 'submitted',
    error: null,
    jobId: 'job-1',
    claimedAt: null,
    submittedAt: new Date('2026-08-25T00:00:00Z'),
    createdAt: new Date('2026-08-25T00:00:00Z'),
    ...overrides,
  };
}

const BASE_BATCH = {
  id: 'batch-1',
  userId: 'user-1',
  areaPath: 'Project\\Area1',
  customerId: null,
  mode: 'baseline',
  state: null,
  iterationPath: null,
  model: null,
  createdAt: new Date('2026-08-25T00:00:00Z'),
};

describe('BatchService.getBatch', () => {
  it('returns null for an unknown batch id', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue(null);
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    expect(await service.getBatch('missing')).toBeNull();
  });

  it('reports a mixed-status batch against the exact summary shape, including the always-present dedup note', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({
      ...BASE_BATCH,
      files: [
        makeBatchFile({ id: 'f1', ordinal: 0, jobId: 'job-1', sourceHash: 'h1' }),
        makeBatchFile({ id: 'f2', ordinal: 1, jobId: null, status: 'queued', sourceHash: 'h2' }),
        makeBatchFile({ id: 'f3', ordinal: 2, jobId: null, status: 'invalid', error: 'unsupported file type: .exe', sourceHash: 'h3' }),
      ],
    });
    prisma.job.findMany.mockResolvedValue([
      {
        id: 'job-1',
        status: 'diff_ready',
        dryRunDiff: [{ action: 'create' }, { action: 'reuse' }],
        warnings: [{ kind: 'dropped_blocks' }],
        _count: { createdItemMappings: 0 },
      },
    ]);
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.summary).toEqual({
      filesTotal: 3,
      filesQueued: 1,
      filesRunning: 0,
      filesAwaitingReview: 1,
      filesSucceeded: 0,
      filesFailed: 1,
      filesRejected: 0,
      filesPending: 1,
      created: 1,
      reused: 1,
      dedupSkipped: 0,
      flagged: 0,
      itemsWritten: 0,
      warningCount: 1,
      warningKinds: { dropped_blocks: 1 },
    });
    expect(result?.notes.map((n) => n.kind)).toContain('cross_file_dedup_deferred');
    expect(result?.notes.map((n) => n.kind)).toContain('files_not_submitted');
  });

  it("excludes an entry (and its whole subtree) from the batch-level diffSummary counts, matching JobsService.getSummary's own exclusion rule", async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({
      ...BASE_BATCH,
      files: [makeBatchFile({ id: 'f1', ordinal: 0, jobId: 'job-1', sourceHash: 'h1' })],
    });
    prisma.job.findMany.mockResolvedValue([
      {
        id: 'job-1',
        status: 'diff_ready',
        dryRunDiff: [
          { localId: 'feat-1', parentLocalId: null, action: 'create', excluded: true },
          { localId: 'req-1', parentLocalId: 'feat-1', action: 'create' },
          { localId: 'req-2', parentLocalId: null, action: 'reuse' },
        ],
        warnings: [],
        _count: { createdItemMappings: 0 },
      },
    ]);
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.summary.created).toBe(0);
    expect(result?.summary.reused).toBe(1);
  });

  it("reports a file as 'deleted' when its jobId no longer resolves to a real Job", async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({ ...BASE_BATCH, files: [makeBatchFile({ id: 'f1', jobId: 'job-gone' })] });
    prisma.job.findMany.mockResolvedValue([]); // the job was deleted
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.files[0].status).toBe('deleted');
  });

  it('fires identical_file_content when two accepted files share a sourceHash', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({
      ...BASE_BATCH,
      files: [
        makeBatchFile({ id: 'f1', ordinal: 0, jobId: null, status: 'queued', sourceHash: 'same-hash' }),
        makeBatchFile({ id: 'f2', ordinal: 1, jobId: null, status: 'queued', sourceHash: 'same-hash' }),
      ],
    });
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.notes.map((n) => n.kind)).toContain('identical_file_content');
  });

  it('does not fire identical_file_content for two invalid files that happen to share a hash', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({
      ...BASE_BATCH,
      files: [
        makeBatchFile({ id: 'f1', ordinal: 0, jobId: null, status: 'invalid', sourceHash: 'same-hash' }),
        makeBatchFile({ id: 'f2', ordinal: 1, jobId: null, status: 'invalid', sourceHash: 'same-hash' }),
      ],
    });
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.notes.map((n) => n.kind)).not.toContain('identical_file_content');
  });

  it('fires survey_throttled only when the batch is SURVEY and something is still queued', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({
      ...BASE_BATCH,
      mode: 'survey',
      files: [makeBatchFile({ id: 'f1', ordinal: 0, jobId: null, status: 'queued' })],
    });
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.notes.map((n) => n.kind)).toContain('survey_throttled');
    expect(result?.notes.find((n) => n.kind === 'survey_throttled')?.message).toContain('2');
  });

  it('does not fire survey_throttled for a BASELINE batch even with queued files', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({
      ...BASE_BATCH,
      mode: 'baseline',
      files: [makeBatchFile({ id: 'f1', ordinal: 0, jobId: null, status: 'queued' })],
    });
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.notes.map((n) => n.kind)).not.toContain('survey_throttled');
  });

  it('assigns 1-based queuePosition to queued files in ordinal order', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findUnique.mockResolvedValue({
      ...BASE_BATCH,
      files: [
        makeBatchFile({ id: 'f1', ordinal: 0, jobId: null, status: 'queued' }),
        makeBatchFile({ id: 'f2', ordinal: 1, jobId: 'job-1' }), // not queued -- no position
        makeBatchFile({ id: 'f3', ordinal: 2, jobId: null, status: 'queued' }),
      ],
    });
    prisma.job.findMany.mockResolvedValue([{ id: 'job-1', status: 'succeeded', dryRunDiff: [], warnings: [], _count: { createdItemMappings: 0 } }]);
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.getBatch('batch-1');

    expect(result?.files.find((f) => f.id === 'f1')?.queuePosition).toBe(1);
    expect(result?.files.find((f) => f.id === 'f2')?.queuePosition).toBeNull();
    expect(result?.files.find((f) => f.id === 'f3')?.queuePosition).toBe(2);
  });
});

describe('BatchService.listBatches', () => {
  it('scopes to the given userId and returns lightweight per-batch aggregates', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findMany.mockResolvedValue([
      { ...BASE_BATCH, id: 'batch-1', files: [makeBatchFile({ jobId: 'job-1' }), makeBatchFile({ id: 'f2', jobId: null, status: 'queued' })] },
    ]);
    prisma.job.findMany.mockResolvedValue([{ id: 'job-1', status: 'succeeded' }]);
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.listBatches('user-1');

    expect(prisma.jobBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
    expect(result).toEqual([
      { id: 'batch-1', createdAt: BASE_BATCH.createdAt, areaPath: 'Project\\Area1', mode: 'baseline', filesTotal: 2, filesSucceeded: 1, filesFailed: 0, filesPending: 1 },
    ]);
  });

  it('returns an empty array without querying Job when the user has no batches', async () => {
    const prisma = makePrisma();
    prisma.jobBatch.findMany.mockResolvedValue([]);
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.listBatches('user-1');

    expect(result).toEqual([]);
    expect(prisma.job.findMany).not.toHaveBeenCalled();
  });
});

describe('BatchService.cancelQueued', () => {
  it('flips only queued files in this batch to cancelled, and returns the count', async () => {
    const prisma = makePrisma();
    prisma.jobBatchFile.updateMany.mockResolvedValue({ count: 3 });
    const service = new BatchService(prisma, {} as any, 25 * 1024 * 1024, 2, 5 * 60_000);

    const result = await service.cancelQueued('batch-1');

    expect(result).toEqual({ cancelled: 3 });
    expect(prisma.jobBatchFile.updateMany).toHaveBeenCalledWith({
      where: { batchId: 'batch-1', status: 'queued' },
      data: { status: 'cancelled' },
    });
  });
});
