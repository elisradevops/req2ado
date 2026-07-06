import { DryRunService } from '../src/modules/writeback/dry-run.service';
import type { IdempotencyService } from '../src/modules/writeback/idempotency.service';

describe('DryRunService', () => {
  const fakeIdempotencyService = { lookup: jest.fn() } as unknown as IdempotencyService;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks a node as "create" when no existing mapping is found', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result).toEqual([
      {
        localId: 'n0',
        parentLocalId: null,
        type: 'Requirement',
        title: 'Title 0',
        description: 'Desc 0',
        action: 'create',
        existingAdoId: null,
        similarity: null,
        sourceHash: 'hash1',
        customerId: null,
      },
    ]);
  });

  it('marks a node as "reuse" when an existing mapping is found', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(42);
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: 'CUST-1',
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result).toEqual([
      {
        localId: 'n0',
        parentLocalId: null,
        type: 'Requirement',
        title: 'Title 0',
        description: 'Desc 0',
        action: 'reuse',
        existingAdoId: 42,
        similarity: null,
        sourceHash: 'hash1',
        customerId: 'CUST-1',
      },
    ]);
  });

  it('diffs every node in a multi-node tree independently', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(7);
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Feature',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
        {
          localId: 'n1',
          parentLocalId: 'n0',
          type: 'Requirement',
          title: 'Title 1',
          description: 'Desc 1',
          sourceHash: 'hash2',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result).toEqual([
      {
        localId: 'n0',
        parentLocalId: null,
        type: 'Feature',
        title: 'Title 0',
        description: 'Desc 0',
        action: 'create',
        existingAdoId: null,
        similarity: null,
        sourceHash: 'hash1',
        customerId: null,
      },
      {
        localId: 'n1',
        parentLocalId: 'n0',
        type: 'Requirement',
        title: 'Title 1',
        description: 'Desc 1',
        action: 'reuse',
        existingAdoId: 7,
        similarity: null,
        sourceHash: 'hash2',
        customerId: null,
      },
    ]);
  });

  it('does not call any MCP tool or perform any write — pure diff', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
    );
    // No assertion needed beyond "this test exists and only calls lookup()"
    // — DryRunService has no MCP client dependency at all by construction,
    // so there is nothing else it COULD call.
    expect(fakeIdempotencyService.lookup).toHaveBeenCalledTimes(1);
  });

  it('marks a node as "dedup_skip" when no exact-hash match exists but dedupCheck finds a duplicate', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: true, matchedItemId: '123', similarity: 0.94 });
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
      dedupCheck,
    );
    expect(result).toEqual([
      {
        localId: 'n0',
        parentLocalId: null,
        type: 'Requirement',
        title: 'Title 0',
        description: 'Desc 0',
        action: 'dedup_skip',
        existingAdoId: 123,
        similarity: 0.94,
        sourceHash: 'hash1',
        customerId: null,
      },
    ]);
    expect(dedupCheck).toHaveBeenCalledWith('Desc 0', 'Project\\Area1');
  });

  it('marks a node as "create" when no exact-hash match exists and dedupCheck finds no duplicate', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: false, matchedItemId: null, similarity: null });
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
      dedupCheck,
    );
    expect(result).toEqual([
      {
        localId: 'n0',
        parentLocalId: null,
        type: 'Requirement',
        title: 'Title 0',
        description: 'Desc 0',
        action: 'create',
        existingAdoId: null,
        similarity: null,
        sourceHash: 'hash1',
        customerId: null,
      },
    ]);
  });

  it('never calls dedupCheck for a node that already has an exact-hash reuse match', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(42);
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: true, matchedItemId: '999', similarity: 0.99 });
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
      dedupCheck,
    );
    expect(result[0].action).toBe('reuse');
    expect(result[0].existingAdoId).toBe(42);
    expect(dedupCheck).not.toHaveBeenCalled();
  });

  it('behaves byte-identically to before this task when dedupCheck is not passed at all', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result).toEqual([
      {
        localId: 'n0',
        parentLocalId: null,
        type: 'Requirement',
        title: 'Title 0',
        description: 'Desc 0',
        action: 'create',
        existingAdoId: null,
        similarity: null,
        sourceHash: 'hash1',
        customerId: null,
      },
    ]);
  });

  it('fails OPEN: a dedupCheck that rejects does not propagate out of diff(), and the node still gets action="create"', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const dedupCheck = jest.fn().mockRejectedValue(new Error('embedding service unreachable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: 'Desc 0',
          sourceHash: 'hash1',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
        {
          localId: 'n1',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 1',
          description: 'Desc 1',
          sourceHash: 'hash2',
          customerId: null,
          areaPath: 'Project\\Area1',
        },
      ],
      fakeIdempotencyService,
      dedupCheck,
    );
    expect(result).toEqual([
      {
        localId: 'n0',
        parentLocalId: null,
        type: 'Requirement',
        title: 'Title 0',
        description: 'Desc 0',
        action: 'create',
        existingAdoId: null,
        similarity: null,
        sourceHash: 'hash1',
        customerId: null,
      },
      {
        localId: 'n1',
        parentLocalId: null,
        type: 'Requirement',
        title: 'Title 1',
        description: 'Desc 1',
        action: 'create',
        existingAdoId: null,
        similarity: null,
        sourceHash: 'hash2',
        customerId: null,
      },
    ]);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
