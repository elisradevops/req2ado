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
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
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
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
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
});
