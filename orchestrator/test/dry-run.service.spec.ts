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
          tags: [],
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
        tags: [],
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
          tags: [],
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
        tags: [],
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
          tags: [],
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
          tags: [],
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
        tags: [],
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
        tags: [],
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
          tags: [],
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
          tags: [],
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
        tags: [],
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
          tags: [],
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
        tags: [],
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
          tags: [],
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
          tags: [],
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
        tags: [],
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
          tags: [],
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
          tags: [],
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
        tags: [],
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
        tags: [],
      },
    ]);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('carries tags through from tree node to diff entry', async () => {
    const nodes = [
      {
        localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
        sourceHash: 'h1', customerId: null, areaPath: 'Proj\\Area', tags: ['functional', 'safety'],
      },
    ];
    const service = new DryRunService();
    const diff = await service.diff(nodes as any, { lookup: jest.fn().mockResolvedValue(null) } as any);
    expect(diff[0].tags).toEqual(['functional', 'safety']);
  });

  it('carries qualityScore and qualityIssues through from tree node to diff entry', async () => {
    const nodes = [
      {
        localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
        sourceHash: 'h1', customerId: null, areaPath: 'Proj\\Area', tags: [],
        qualityScore: 72, qualityIssues: ['vague_term'],
      },
    ];
    const service = new DryRunService();
    const diff = await service.diff(nodes as any, { lookup: jest.fn().mockResolvedValue(null) } as any);
    expect(diff[0].qualityScore).toBe(72);
    expect(diff[0].qualityIssues).toEqual(['vague_term']);
  });

  it('leaves qualityScore/qualityIssues undefined when the tree node omits them (byte-identical pre-P2c behavior)', async () => {
    const nodes = [
      {
        localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
        sourceHash: 'h1', customerId: null, areaPath: 'Proj\\Area', tags: [],
      },
    ];
    const service = new DryRunService();
    const diff = await service.diff(nodes as any, { lookup: jest.fn().mockResolvedValue(null) } as any);
    expect(diff[0].qualityScore).toBeUndefined();
    expect(diff[0].qualityIssues).toBeUndefined();
  });
});
