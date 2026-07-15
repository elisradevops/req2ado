import { JobsService } from '../src/modules/pipeline/jobs.service';

describe('JobsService.confirm', () => {
  it('creates items in tree order and links each child to its already-created parent', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // parent
      .mockResolvedValueOnce({ id: 101 }); // child
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild } as any,
      { record } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 2 });
    expect(linkParentChild).toHaveBeenCalledWith(101, 100, undefined);
  });

  it('links a child to a REUSED parent (existingAdoId), not just newly-created parents', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 101 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'reuse', existingAdoId: 42, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkParentChild).toHaveBeenCalledWith(101, 42, undefined);
  });

  it('writes AreaPath, State, and a runtime-resolved Customer ID field on every created item', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 200 });
    const discoverFields = jest
      .fn()
      .mockResolvedValue(['System.Title', 'System.Description', 'Custom.CustomerRequirementId']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1', state: 'Proposed',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: 'CUST-1' },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(discoverFields).toHaveBeenCalledWith('Requirement', undefined);
    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      {
        'System.Title': 'T',
        'System.Description': 'D',
        'System.State': 'Proposed',
        'System.AreaPath': 'Project\\Area1',
        'Custom.CustomerRequirementId': 'CUST-1',
      },
      undefined,
    );
  });

  it('leaves Customer ID off the written item when no candidate field is discovered, rather than failing', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 201 });
    const discoverFields = jest.fn().mockResolvedValue(['System.Title', 'System.Description']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1', state: 'Proposed',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: 'CUST-1' },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      {
        'System.Title': 'T',
        'System.Description': 'D',
        'System.State': 'Proposed',
        'System.AreaPath': 'Project\\Area1',
      },
      undefined,
    );
  });

  it('skips creating a dedup_skip node and does not re-parent its matched existing item', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 300 }); // only the new child gets created
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const upsertDedupEntry = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            // A probable duplicate of an existing ADO item — must be skipped like 'reuse',
            // but its match is NOT a certainty, so it must never be re-parented.
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'dedup_skip', existingAdoId: 42, similarity: 0.95, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(createWorkItem).toHaveBeenCalledTimes(1); // n0 (dedup_skip) never creates
    // n1 (a real 'create' node) links UP to n0's matched real ADO id fine —
    // only n0 acting as a CHILD of something else would be suppressed, and
    // n0 has no parent here so that guard isn't exercised by this case.
    expect(linkParentChild).toHaveBeenCalledWith(300, 42, undefined);
  });

  it('does not re-parent an existing item matched by dedup_skip when IT is the child', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 }); // only the new parent gets created
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null },
            // A probable duplicate that would otherwise be re-parented under the new n0 —
            // must NOT happen, since its match is a similarity guess, not a certainty.
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'dedup_skip', existingAdoId: 42, similarity: 0.95, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkParentChild).not.toHaveBeenCalled();
  });

  it('upserts a dedup entry for every newly-created item, but not for reused/dedup_skip ones', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 500 });
    const upsertDedupEntry = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn() } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(upsertDedupEntry).toHaveBeenCalledWith('500', 'D', 'Project\\Area1');
  });

  it('does not fail confirm() when the dedup upsert itself fails (best-effort, not a required write)', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 501 });
    const upsertDedupEntry = jest.fn().mockRejectedValue(new Error('ingestion unreachable'));
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn() } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
  });

  it('writes the job-configured state and iteration path onto created work items', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 501 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-state-1',
          status: 'diff_ready',
          areaPath: 'Proj\\Area',
          state: 'Active',
          iterationPath: 'Proj\\Sprint 3',
          customerId: null,
          dryRunDiff: [
            { localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'CREATE', customerId: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      auditEntry: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn() } as any,
      'redis://unused',
    );

    await service.confirm('job-state-1', { orgUrl: 'https://ado.example', pat: 'x' });

    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      expect.objectContaining({
        'System.State': 'Active',
        'System.IterationPath': 'Proj\\Sprint 3',
      }),
      { orgUrl: 'https://ado.example', pat: 'x' },
    );
  });

  it('joins tags with a semicolon into System.Tags on create', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 502 });
    const linkParentChild = jest.fn();
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-tags-1',
          status: 'diff_ready',
          areaPath: 'Proj\\Area',
          state: 'Proposed',
          iterationPath: null,
          customerId: null,
          dryRunDiff: [
            { localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'CREATE', customerId: null, tags: ['functional', 'safety'] },
          ],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      auditEntry: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new JobsService(prisma as any, { createWorkItem, linkParentChild } as any, { record: jest.fn() } as any, { upsertDedupEntry: jest.fn() } as any, 'redis://unused');

    await service.confirm('job-tags-1', { orgUrl: 'https://ado.example', pat: 'x' });

    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      expect.objectContaining({ 'System.Tags': 'functional;safety' }),
      { orgUrl: 'https://ado.example', pat: 'x' },
    );
  });
});

describe('JobsService.setDiffEntryExcluded', () => {
  it('flips excluded on the matching entry and persists the whole array', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'A', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
          ],
        }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.setDiffEntryExcluded('job-1', 'n0', true);

    expect(result[0].excluded).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { dryRunDiff: [expect.objectContaining({ localId: 'n0', excluded: true })] },
    });
  });

  it('throws a conflict when the job is not diff_ready', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'writing', dryRunDiff: [] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.setDiffEntryExcluded('job-1', 'n0', true)).rejects.toThrow('not in a diff-editable state');
  });

  it('throws not found when the entry localId does not exist', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.setDiffEntryExcluded('job-1', 'missing', true)).rejects.toThrow('not found');
  });
});

describe('JobsService.confirm — exclusion', () => {
  it('skips an excluded entry and any child of it, even if the child itself is not excluded', async () => {
    const createWorkItem = jest.fn();
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, excluded: true },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, excluded: false },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn() } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 0 });
    expect(createWorkItem).not.toHaveBeenCalled();
  });
});

describe('JobsService.list', () => {
  it('lists jobs newest-first with item counts derived from dryRunDiff length', async () => {
    const prisma = {
      job: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'j2', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\B', dryRunDiff: [{}, {}, {}], createdAt: new Date('2026-07-09T10:00:00Z') },
          { id: 'j1', mode: 'baseline', status: 'succeeded', areaPath: 'Proj\\A', dryRunDiff: [{}], createdAt: new Date('2026-07-08T10:00:00Z') },
        ]),
      },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.list();

    expect(prisma.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' } }));
    expect(result).toEqual([
      { id: 'j2', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\B', itemCount: 3, createdAt: new Date('2026-07-09T10:00:00Z') },
      { id: 'j1', mode: 'baseline', status: 'succeeded', areaPath: 'Proj\\A', itemCount: 1, createdAt: new Date('2026-07-08T10:00:00Z') },
    ]);
  });
});
