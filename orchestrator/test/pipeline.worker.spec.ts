import { runPipelineJob } from '../src/modules/pipeline/pipeline.worker';

describe('runPipelineJob', () => {
  const fakeIngestionClient = { ingest: jest.fn(), level: jest.fn(), checkDuplicate: jest.fn() };
  const fakeDryRunService = { diff: jest.fn() };
  const fakeIdempotencyService = { lookup: jest.fn(), record: jest.fn() };
  const fakePrisma = { job: { update: jest.fn() }, auditEntry: { create: jest.fn() } };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('calls ingest, then level, then computes a dry-run diff', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [{ id: 'b0' }] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [{ local_id: 'n0', source_ref: {}, fidelity_hash: 'hash1', customer_id: 'CUST-1' }],
    });
    fakeDryRunService.diff.mockResolvedValue([{ localId: 'n0', action: 'create', existingAdoId: null }]);

    const result = await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from('text'), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
      },
    );

    expect(fakeIngestionClient.ingest).toHaveBeenCalledWith(Buffer.from('text'), 'x.txt');
    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [{ id: 'b0' }] }, 'CUST-1', 'baseline');
    expect(result).toEqual([{ localId: 'n0', action: 'create', existingAdoId: null }]);
  });

  it('passes job.mode through to ingestionClient.level', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey');
  });

  it('updates the Job row status to diff_ready and stores the diff on success', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'diff_ready', dryRunDiff: [] },
    });
  });

  it('sets Job status to failed and rethrows if ingestion fails', async () => {
    fakeIngestionClient.ingest.mockRejectedValue(new Error('ingestion service down'));

    await expect(
      runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
        },
      ),
    ).rejects.toThrow('ingestion service down');

    expect(fakePrisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'failed' } });
  });

  it("passes each node's source_hash/customer_id/areaPath to the dry-run diff, not the whole tree blindly", async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        { local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1' },
        { local_id: 'n1', fidelity_hash: 'hashB', customer_id: 'CUST-1' },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        { localId: 'n0', sourceHash: 'hashA', customerId: 'CUST-1', areaPath: 'Project\\Area1', tags: [] },
        { localId: 'n1', sourceHash: 'hashB', customerId: 'CUST-1', areaPath: 'Project\\Area1', tags: [] },
      ],
      fakeIdempotencyService,
      expect.any(Function),
    );
  });

  it('carries parent_local_id/type/title/description from ingestion through to the dry-run diff input', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          parent_local_id: null,
          type: 'Feature',
          title: 'Parent Title',
          description: 'Parent Desc',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
        },
        {
          local_id: 'n1',
          parent_local_id: 'n0',
          type: 'Requirement',
          title: 'Child Title',
          description: 'Child Desc',
          fidelity_hash: 'hashB',
          customer_id: 'CUST-1',
        },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Feature',
          title: 'Parent Title',
          description: 'Parent Desc',
          sourceHash: 'hashA',
          customerId: 'CUST-1',
          areaPath: 'Project\\Area1',
          tags: [],
        },
        {
          localId: 'n1',
          parentLocalId: 'n0',
          type: 'Requirement',
          title: 'Child Title',
          description: 'Child Desc',
          sourceHash: 'hashB',
          customerId: 'CUST-1',
          areaPath: 'Project\\Area1',
          tags: [],
        },
      ],
      fakeIdempotencyService,
      expect.any(Function),
    );
  });

  it('supplies a dedupCheck callback to dryRunService.diff that calls ingestionClient.checkDuplicate with (description, areaPath)', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          parent_local_id: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
        },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);
    fakeIngestionClient.checkDuplicate.mockResolvedValue({ isDuplicate: false, matchedItemId: null, similarity: null });

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
      },
    );

    const dedupCheckArg = fakeDryRunService.diff.mock.calls[0][2];
    await dedupCheckArg('Desc 0', 'Project\\Area1');
    expect(fakeIngestionClient.checkDuplicate).toHaveBeenCalledWith('Desc 0', 'Project\\Area1');
  });
});
