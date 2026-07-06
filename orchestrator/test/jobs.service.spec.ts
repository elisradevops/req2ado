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
    const service = new JobsService(prisma as any, { createWorkItem, linkParentChild } as any, { record } as any, 'redis://unused');

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
    const service = new JobsService(prisma as any, { createWorkItem, linkParentChild } as any, { record: jest.fn() } as any, 'redis://unused');

    await service.confirm('job-1');

    expect(linkParentChild).toHaveBeenCalledWith(101, 42, undefined);
  });
});
