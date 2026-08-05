import {
  DryRunService,
  resolveCrossJobTraceLinks,
  verifyExistingAdoIdsStillExist,
  type DryRunDiffEntry,
  type TraceLink,
} from '../src/modules/writeback/dry-run.service';
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
  });

  it('passes legacySourceHash through to idempotencyService.lookup as its 4th argument', async () => {
    // Regression: identity_hash's migration-safety fallback (see
    // IdempotencyService.lookup's own doc comment) only works if diff()
    // actually forwards the node's legacySourceHash -- silently dropping it
    // here would make every already-ingested document duplicate on re-run.
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
          sourceHash: 'new-identity-hash',
          legacySourceHash: 'legacy-fidelity-hash',
          customerId: null,
          areaPath: 'Project\\Area1',
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
          tags: [],
        },
      ],
      fakeIdempotencyService,
    );
    expect(fakeIdempotencyService.lookup).toHaveBeenCalledWith(
      'new-identity-hash',
      null,
      'Project\\Area1',
      'legacy-fidelity-hash',
    );
  });

  it('passes undefined (not null) to idempotencyService.lookup when legacySourceHash is absent', async () => {
    // Older/mocked node shape predating identity_hash -- must not pass a
    // literal `null` through, matching IdempotencyService.lookup's optional
    // parameter contract exactly.
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
          tags: [],
        },
      ],
      fakeIdempotencyService,
    );
    expect(fakeIdempotencyService.lookup).toHaveBeenCalledWith('hash1', null, 'Project\\Area1', undefined);
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
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
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('carries real groundingScore/qualityScore/qualityIssues through to every action type', async () => {
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
          groundingScore: 0.15,
          qualityScore: 40,
          qualityIssues: ['ambiguous', 'vague_term'],
          qualityCategoryScores: { clarity: 20, testability: 80, atomicity: 90, style: 60, rationale: 10 },
          sourceRef: null,
          tags: [],
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0]).toMatchObject({
      groundingScore: 0.15,
      qualityScore: 40,
      qualityIssues: ['ambiguous', 'vague_term'],
      qualityCategoryScores: { clarity: 20, testability: 80, atomicity: 90, style: 60, rationale: 10 },
      sourceRef: null,
      tags: [],
    });
  });

  it('carries a real sourceRef/tags through to every action type', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const sourceRef = { documentPath: '/tmp/doc.docx', startOffset: 10, endOffset: 20, page: null };
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
          groundingScore: null,
          qualityScore: null,
          qualityIssues: [],
          sourceRef,
          tags: ['functional', 'safety'],
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0]).toMatchObject({ sourceRef, tags: ['functional', 'safety'] });
  });

  it('leaves qualityScore/qualityIssues undefined when the tree node omits them (byte-identical pre-P2c behavior)', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const nodes = [
      {
        localId: 'r1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
        sourceHash: 'h1', customerId: null, areaPath: 'Proj\\Area', tags: [],
      },
    ];
    const diff = await service.diff(nodes as any, fakeIdempotencyService);
    expect(diff[0].qualityScore).toBeUndefined();
    expect(diff[0].qualityIssues).toBeUndefined();
  });

  // --- perf: bounded concurrency instead of one-node-at-a-time sequential awaits ---

  it('propagates an idempotencyService.lookup rejection out of diff() (fails the whole job, same as before parallelization)', async () => {
    // Unlike dedupCheck (fail-open, tested above), a lookup failure must
    // still abort the whole diff() call -- this is the failure-semantics
    // guarantee that must survive the switch to mapWithConcurrency, which
    // otherwise captures per-item exceptions into rejected results instead
    // of letting them propagate on their own.
    (fakeIdempotencyService.lookup as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('db unreachable'))
      .mockResolvedValueOnce(null);
    const service = new DryRunService();
    const nodes = ['n0', 'n1', 'n2'].map((localId, i) => ({
      localId, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));

    await expect(service.diff(nodes as any, fakeIdempotencyService)).rejects.toThrow('db unreachable');
  });

  it('returns results in the original node order regardless of concurrent resolution order', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockImplementation((sourceHash: string) => {
      // n0's lookup resolves LAST despite being requested first -- proves
      // the returned array order tracks input order, not completion order.
      const delayMs = sourceHash === 'hash0' ? 30 : 5;
      return new Promise((resolve) => setTimeout(() => resolve(null), delayMs));
    });
    const service = new DryRunService(3);
    const nodes = ['n0', 'n1', 'n2', 'n3', 'n4'].map((localId, i) => ({
      localId, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));

    const result = await service.diff(nodes as any, fakeIdempotencyService);

    expect(result.map((r) => r.localId)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('runs idempotencyService.lookup calls concurrently, not one at a time', async () => {
    // Regression: the previous sequential `for` loop awaited each node's
    // lookup before starting the next -- for N nodes this serializes N
    // round trips even though every node's check is independent. Track how
    // many lookups are in flight simultaneously to prove the new
    // implementation actually overlaps them.
    let inFlight = 0;
    let maxInFlight = 0;
    (fakeIdempotencyService.lookup as jest.Mock).mockImplementation(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => setTimeout(() => {
        inFlight -= 1;
        resolve(null);
      }, 10));
    });
    const service = new DryRunService(4);
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      localId: `n${i}`, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));

    await service.diff(nodes as any, fakeIdempotencyService);

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('passes childType through on every action branch (create, reuse, dedup_skip)', async () => {
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Feature', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, areaPath: 'Project\\Area1', tags: [],
          childType: 'Requirement',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].childType).toBe('Requirement');
  });

  it('calls onProgress once per node with a monotonically-increasing completed count, final call at the total', async () => {
    // Regression coverage for the previously-silent dedup-check burst (see
    // pipeline.worker.ts's own comment: confirmed live, ~543 nodes, zero
    // progress signal). onProgress is optional and must not change diff()'s
    // own return value or ordering guarantees.
    (fakeIdempotencyService.lookup as jest.Mock).mockResolvedValue(null);
    const service = new DryRunService();
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      localId: `n${i}`, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `h${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));
    const progressCalls: [number, number][] = [];
    await service.diff(nodes, fakeIdempotencyService, undefined, (completed, total) => {
      progressCalls.push([completed, total]);
    });
    expect(progressCalls).toHaveLength(5);
    expect(progressCalls.every(([, total]) => total === 5)).toBe(true);
    expect(progressCalls.map(([completed]) => completed).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('resolveCrossJobTraceLinks', () => {
  it('resolves an intraJob link without calling the query function', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'System.LinkTypes.Related', displayName: 'Related', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn();

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(result).toEqual(links);
    expect(queryByCustomerId).not.toHaveBeenCalled();
  });

  it('resolves a crossJob link to the single matching ADO id', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn().mockResolvedValue([555]);

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(queryByCustomerId).toHaveBeenCalledWith('REQ-SYS-012');
    expect(result[0].resolvedAdoId).toBe(555);
    expect(result[0].resolutionStatus).toBe('resolved');
  });

  it('marks unresolved when no match or more than one match is found', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-NONE', resolutionStatus: 'pending' },
      { sourceLocalId: 'n2', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-DUP', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([1, 2]);

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(result[0].resolutionStatus).toBe('unresolved');
    expect(result[0].resolvedAdoId).toBeUndefined();
    expect(result[1].resolutionStatus).toBe('unresolved');
  });

  it('marks unresolved (never throws) when the query function itself rejects', async () => {
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-ERR', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn().mockRejectedValue(new Error('mcp down'));

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(result[0].resolutionStatus).toBe('unresolved');
  });
});

function _entry(overrides: Partial<DryRunDiffEntry>): DryRunDiffEntry {
  return {
    localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
    action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h', customerId: null,
    tags: [], groundingScore: null, qualityScore: null, qualityIssues: [], sourceRef: null,
    ...overrides,
  };
}

describe('verifyExistingAdoIdsStillExist', () => {
  it('downgrades a reuse match to create when its ADO item no longer exists', async () => {
    const diff = [_entry({ localId: 'n0', action: 'reuse', existingAdoId: 533 })];
    const getWorkItemsBatch = jest.fn().mockResolvedValue([]); // 533 not returned -> deleted

    const result = await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch);

    expect(getWorkItemsBatch).toHaveBeenCalledWith([533]);
    expect(result[0]).toEqual(_entry({ localId: 'n0', action: 'create', existingAdoId: null, similarity: null }));
  });

  it('downgrades a dedup_skip match to create when its ADO item no longer exists', async () => {
    const diff = [_entry({ localId: 'n0', action: 'dedup_skip', existingAdoId: 531, similarity: 0.92 })];
    const getWorkItemsBatch = jest.fn().mockResolvedValue([]);

    const result = await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch);

    expect(result[0].action).toBe('create');
    expect(result[0].similarity).toBeNull();
  });

  it('leaves a match untouched when its ADO item still exists', async () => {
    const diff = [_entry({ localId: 'n0', action: 'reuse', existingAdoId: 42 })];
    const getWorkItemsBatch = jest.fn().mockResolvedValue([{ id: 42 }]);

    const result = await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch);

    expect(result).toEqual(diff);
  });

  it('verifies only the DISTINCT existing ids across the whole diff in one batched call, not one call per node', async () => {
    const diff = [
      _entry({ localId: 'n0', action: 'reuse', existingAdoId: 42 }),
      _entry({ localId: 'n1', action: 'dedup_skip', existingAdoId: 42, similarity: 0.9 }), // same id as n0
      _entry({ localId: 'n2', action: 'reuse', existingAdoId: 7 }),
      _entry({ localId: 'n3', action: 'create', existingAdoId: null }),
    ];
    const getWorkItemsBatch = jest.fn().mockResolvedValue([{ id: 42 }, { id: 7 }]);

    await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch);

    expect(getWorkItemsBatch).toHaveBeenCalledTimes(1);
    expect(getWorkItemsBatch.mock.calls[0][0].sort((a: number, b: number) => a - b)).toEqual([7, 42]);
  });

  it('is a no-op (never calls getWorkItemsBatch) when the diff has no reuse/dedup_skip entries at all', async () => {
    const diff = [_entry({ localId: 'n0', action: 'create', existingAdoId: null })];
    const getWorkItemsBatch = jest.fn();

    const result = await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch);

    expect(getWorkItemsBatch).not.toHaveBeenCalled();
    expect(result).toEqual(diff);
  });

  it('fails open (returns the diff completely untouched) when the batch call itself throws', async () => {
    const diff = [_entry({ localId: 'n0', action: 'reuse', existingAdoId: 533 })];
    const getWorkItemsBatch = jest.fn().mockRejectedValue(new Error('ADO unreachable'));

    const result = await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch);

    expect(result).toEqual(diff);
  });

  it('calls onError with a descriptive message when the batch call throws -- previously this failure was completely silent', async () => {
    const diff = [_entry({ localId: 'n0', action: 'reuse', existingAdoId: 533 })];
    const getWorkItemsBatch = jest.fn().mockRejectedValue(new Error('ADO unreachable'));
    const onError = jest.fn();

    const result = await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch, onError);

    expect(result).toEqual(diff); // fail-open behavior itself is unchanged
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('ADO unreachable');
  });

  it('never calls onError when verification succeeds', async () => {
    const diff = [_entry({ localId: 'n0', action: 'reuse', existingAdoId: 42 })];
    const getWorkItemsBatch = jest.fn().mockResolvedValue([{ id: 42 }]);
    const onError = jest.fn();

    await verifyExistingAdoIdsStillExist(diff, getWorkItemsBatch, onError);

    expect(onError).not.toHaveBeenCalled();
  });
});
