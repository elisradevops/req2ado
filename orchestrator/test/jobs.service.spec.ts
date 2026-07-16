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

describe('JobsService.editDiffEntry', () => {
  const baseEntry = { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Old', description: 'Old desc', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null };

  it('updates title and description on a create entry', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New', description: 'New desc' });

    expect(result[0].title).toBe('New');
    expect(result[0].description).toBe('New desc');
  });

  it('rejects editing a reuse entry', async () => {
    const reuseEntry = { ...baseEntry, action: 'reuse', existingAdoId: 42 };
    const update = jest.fn();
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [reuseEntry] }), update },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.editDiffEntry('job-1', 'n0', { title: 'New' })).rejects.toThrow('only create entries can be edited');
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves description when only title is supplied in the patch', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New Title' });

    expect(result[0].title).toBe('New Title');
    expect(result[0].description).toBe('Old desc');
  });

  // The HTTP controller extracts title/description independently via
  // @Body('title')/@Body('description'), so a PATCH body that omits
  // `description` still produces a patch object with an explicit
  // `description: undefined` key (JS shorthand property syntax always
  // creates the key). This reproduces that exact shape to guard against
  // the service clobbering an existing description with undefined.
  it('does not clobber description with an explicit undefined value from the controller', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New Title', description: undefined });

    expect(result[0].title).toBe('New Title');
    expect(result[0].description).toBe('Old desc');
  });
});

describe('JobsService.addDiffEntry', () => {
  const parent = { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, childType: 'Requirement' };

  it('appends a new create entry with sha256(description) as sourceHash, for a matching BASELINE childType', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [parent] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'New Req', description: 'New desc' });

    expect(result).toHaveLength(2);
    const added = result[1];
    expect(added.action).toBe('create');
    expect(added.parentLocalId).toBe('n0');
    expect(added.isManual).toBe(true);
    expect(added.childType).toBeNull();
    const crypto = require('crypto');
    expect(added.sourceHash).toBe(crypto.createHash('sha256').update('New desc').digest('hex'));
  });

  it('rejects a BASELINE add whose type does not match the parent childType', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [parent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Feature', title: 'X', description: 'Y' }),
    ).rejects.toThrow('does not match');
  });

  it('accepts any of the three types for a SURVEY job', async () => {
    const surveyParent = { ...parent, childType: null };
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'survey', dryRunDiff: [surveyParent] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Epic', title: 'X', description: 'Y' });

    expect(result[1].type).toBe('Epic');
  });

  it('rejects an invalid type for a SURVEY job', async () => {
    const surveyParent = { ...parent, childType: null };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'survey', dryRunDiff: [surveyParent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Bug', title: 'X', description: 'Y' }),
    ).rejects.toThrow('must be one of');
  });

  it('rejects adding under a manually-added parent', async () => {
    const manualParent = { ...parent, isManual: true, childType: null };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [manualParent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'X', description: 'Y' }),
    ).rejects.toThrow('manually-added');
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

describe('JobsService.confirm — trace links', () => {
  it('writes a resolved intraJob trace link after both endpoints have real ADO ids', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // n0
      .mockResolvedValueOnce({ id: 101 }); // n1
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Sys Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, traceLinks: [] },
            {
              localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Cust Req', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Reverse', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(101, 100, 'Elisra.CoveredBy-Reverse', undefined);
  });

  it('skips writing an unresolved trace link without failing confirm', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-MISSING', resolutionStatus: 'unresolved' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(linkWorkItems).not.toHaveBeenCalled();
  });

  it('writes an already-resolved crossJob trace link using its resolvedAdoId', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n0', referenceName: 'System.LinkTypes.Affects-Forward', displayName: 'Affects', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolvedAdoId: 555, resolutionStatus: 'resolved' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(100, 555, 'System.LinkTypes.Affects-Forward', undefined);
  });

  it('does not abort confirm when linkWorkItems rejects — the failure is logged and swallowed', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // n0
      .mockResolvedValueOnce({ id: 101 }); // n1
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockRejectedValue(new Error('ADO rejected the rel'));
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Sys Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, traceLinks: [] },
            {
              localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Cust Req', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Reverse', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntry: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(101, 100, 'Elisra.CoveredBy-Reverse', undefined);
    expect(result).toEqual({ status: 'succeeded', createdCount: 2 });
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

describe('JobsService.getById', () => {
  it('returns kbCitations alongside the existing job fields', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: [{ localId: 'n0' }],
          kbCitations: ['doc-a.docx'],
        }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getById('job-1');

    expect(result).toEqual({
      id: 'job-1',
      status: 'diff_ready',
      mode: 'survey',
      dryRunDiff: [{ localId: 'n0' }],
      kbCitations: ['doc-a.docx'],
    });
  });

  it('returns null for an unknown job', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    expect(await service.getById('missing')).toBeNull();
  });
});
