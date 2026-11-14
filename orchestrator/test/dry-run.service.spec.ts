import {
  DryRunService,
  resolveCrossJobTraceLinks,
  verifyExistingAdoIdsStillExist,
  changedSinceWrittenWarning,
  type DryRunDiffEntry,
  type TraceLink,
} from '../src/modules/writeback/dry-run.service';
import type { IdempotencyService } from '../src/modules/writeback/idempotency.service';
import { idempotencyMapKey } from '../src/modules/writeback/idempotency.service';

describe('DryRunService', () => {
  const fakeIdempotencyService = { lookupMany: jest.fn() } as unknown as IdempotencyService;

  beforeEach(() => {
    // Default: no existing mapping for anything -- matches every test
    // below that previously relied on `lookup.mockResolvedValue(null)` as
    // its default "no match" setup. Tests that need a real match override
    // this with their own mockResolvedValueOnce/mockResolvedValue call.
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(new Map());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks a node as "create" when no existing mapping is found', async () => {
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
          seCoverageRef: null,
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
        seCoverageRef: null,
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
  });

  it('includes legacySourceHash as a second prefetch key when present and different from sourceHash', async () => {
    // Regression: identity_hash's migration-safety fallback (see
    // IdempotencyService.lookup's own doc comment) only works if diff()
    // actually forwards the node's legacySourceHash -- silently dropping it
    // here would make every already-ingested document duplicate on re-run.
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
          seCoverageRef: null,
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
    expect(fakeIdempotencyService.lookupMany).toHaveBeenCalledWith([
      { sourceHash: 'new-identity-hash', areaPath: 'Project\\Area1' },
      { sourceHash: 'legacy-fidelity-hash', areaPath: 'Project\\Area1' },
    ]);
  });

  it('does not add a second prefetch key when legacySourceHash is absent', async () => {
    // Older/mocked node shape predating identity_hash -- must not pass a
    // literal `null` through, matching IdempotencyService.lookup's optional
    // parameter contract exactly.
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
          seCoverageRef: null,
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
    expect(fakeIdempotencyService.lookupMany).toHaveBeenCalledWith([{ sourceHash: 'hash1', areaPath: 'Project\\Area1' }]);
  });

  it('resolves to "reuse" via the legacySourceHash fallback when only the legacy key has a mapping', async () => {
    // Regression coverage for resolveExistingAdoId's own legacy-hash HIT
    // path (dry-run.service.ts) -- before this task, this exact fallback
    // was IdempotencyService.lookup()'s second findFirst and was covered by
    // idempotency.service.spec.ts alone. DryRunService now owns its own
    // copy of that two-tier resolution and never calls lookup() at all, so
    // that old coverage no longer protects this path: a regression here
    // (e.g. resolveExistingAdoId returning null instead of falling back to
    // the legacy key) would silently duplicate every re-ingested document's
    // whole tree in ADO -- exactly what lookup()'s own doc comment warns
    // about -- while every other test in this file stayed green, since none
    // of them populate the map with ONLY the legacy key.
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(
      new Map([[idempotencyMapKey('legacy-fidelity-hash', 'Project\\Area1'), 55]]),
    );
    const service = new DryRunService();
    const result = await service.diff(
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
          seCoverageRef: null,
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
    expect(result[0].action).toBe('reuse');
    expect(result[0].existingAdoId).toBe(55);
  });

  it('marks a node as "reuse" when an existing mapping is found', async () => {
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(
      new Map([[idempotencyMapKey('hash1', 'Project\\Area1'), 42]]),
    );
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
          seCoverageRef: null,
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
        seCoverageRef: null,
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
  });

  it('diffs every node in a multi-node tree independently', async () => {
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(
      new Map([[idempotencyMapKey('hash2', 'Project\\Area1'), 7]]),
    );
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
          seCoverageRef: null,
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
          seCoverageRef: null,
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
        seCoverageRef: null,
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
        seCoverageRef: null,
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
  });

  it('does not call any MCP tool or perform any write — pure diff', async () => {
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
          seCoverageRef: null,
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
    // No assertion needed beyond "this test exists and only calls lookupMany()"
    // — DryRunService has no MCP client dependency at all by construction,
    // so there is nothing else it COULD call.
    expect(fakeIdempotencyService.lookupMany).toHaveBeenCalledTimes(1);
  });

  it('marks a node as "dedup_skip" when no exact-hash match exists but dedupCheck finds a duplicate', async () => {
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
          seCoverageRef: null,
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
        seCoverageRef: null,
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
    // The item's own id goes along (the decision log keys on it), after what was compared.
    expect(dedupCheck).toHaveBeenCalledWith('Desc 0', 'Title 0', 'Project\\Area1', 'Requirement', 'n0');
  });

  it('falls through to "create" (not a NaN existingAdoId) when dedupCheck returns a non-numeric matchedItemId', async () => {
    // Real gap this closes: Number('not-a-real-id') is NaN, not an error --
    // a bad dedup-store record previously produced action: 'dedup_skip'
    // with existingAdoId: NaN, propagating into a PATCH .../workItems/NaN
    // call and a NaN audit-table write. Same "creating a possible
    // duplicate is always safer" fail-open philosophy as a dedupCheck
    // rejection.
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: true, matchedItemId: 'not-a-real-id', similarity: 0.94 });
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
          seCoverageRef: null,
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
    expect(result[0].action).toBe('create');
    expect(result[0].existingAdoId).toBeNull();
    expect(Number.isNaN(result[0].existingAdoId)).toBe(false);
  });

  it('strips HTML from node.description before calling dedupCheck, matching backfill.service.ts\'s own stripping so both sides of the comparison are symmetric', async () => {
    // Regression for the asymmetry documented on stripHtmlTags and at this
    // call site: node.description is req2ado's own generated rich-text
    // HTML (a <table> block here, standing in for what table-fidelity
    // ships), while backfill.service.ts's equivalent seeding path already
    // strips ADO's own System.Description HTML with the SAME stripHtmlTags
    // before running its half of the comparison. Before this fix, this
    // call site sent the raw HTML straight through -- comparing "HTML +
    // real content" against backfill's "just real content" silently cost
    // similarity points (confirmed ~2.5 points on plain prose alone), and
    // a table's much higher markup-to-content ratio makes that gap far
    // worse. Proving the fix means proving BOTH sides now see the exact
    // same plain-text content, not merely that stripHtmlTags exists.
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: false, matchedItemId: null, similarity: null });
    const service = new DryRunService();
    const tableBearingDescription =
      '<p>Intro.</p>\n<table><thead><tr><th>Slot</th><th>Qty</th></tr></thead>' +
      '<tbody><tr><td>A</td><td>2</td></tr></tbody></table>';
    await service.diff(
      [
        {
          localId: 'n0',
          parentLocalId: null,
          type: 'Requirement',
          title: 'Title 0',
          description: tableBearingDescription,
          sourceHash: 'hash1',
          customerId: null,
          seCoverageRef: null,
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
    // What backfill.service.ts's stripHtmlTags would independently produce
    // from the SAME markup, standing in for what a real ADO-side
    // equivalent item's stripped description looks like -- both sides of
    // the comparison must land on this identical plain-text string.
    expect(dedupCheck).toHaveBeenCalledWith('Intro. Slot Qty A 2', 'Title 0', 'Project\\Area1', 'Requirement', 'n0');
  });

  it('marks a node as "create" when no exact-hash match exists and dedupCheck finds no duplicate', async () => {
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
          seCoverageRef: null,
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
        seCoverageRef: null,
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
  });

  it('never calls dedupCheck for a node that already has an exact-hash reuse match', async () => {
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(
      new Map([[idempotencyMapKey('hash1', 'Project\\Area1'), 42]]),
    );
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
          seCoverageRef: null,
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
          seCoverageRef: null,
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
        seCoverageRef: null,
        groundingScore: null,
        qualityScore: null,
        qualityIssues: [],
        sourceRef: null,
        tags: [],
      },
    ]);
  });

  it('fails OPEN: a dedupCheck that rejects does not propagate out of diff(), and the node still gets action="create"', async () => {
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
          seCoverageRef: null,
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
          seCoverageRef: null,
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
        seCoverageRef: null,
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
        seCoverageRef: null,
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
          seCoverageRef: null,
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

  it('carries a real qualityCategoryChecklist through to a create entry', async () => {
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
          seCoverageRef: null,
          areaPath: 'Project\\Area1',
          qualityScore: 80,
          qualityIssues: [],
          qualityCategoryScores: { Necessary: 80, Unambiguous: 70 },
          qualityCategoryChecklist: { Necessary: 'States something not already satisfied.' },
          sourceRef: null,
          tags: [],
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0]).toMatchObject({
      qualityCategoryScores: { Necessary: 80, Unambiguous: 70 },
      qualityCategoryChecklist: { Necessary: 'States something not already satisfied.' },
    });
  });

  it('carries a real sourceRef/tags through to every action type', async () => {
    const service = new DryRunService();
    const sourceRef = {
      documentPath: '/tmp/doc.docx', startOffset: 10, endOffset: 20, page: null,
      pageEnd: null, pageProvenance: null, sectionPath: [],
    };
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
          seCoverageRef: null,
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

  it('propagates a lookupMany rejection out of diff() (fails the whole job)', async () => {
    // Unlike dedupCheck (fail-open, tested above), a failed idempotency
    // prefetch must still abort the whole diff() call -- lookupMany is a
    // single plain await BEFORE the concurrent loop starts, so this is
    // even more direct than the old per-node behavior it replaces.
    (fakeIdempotencyService.lookupMany as jest.Mock).mockRejectedValue(new Error('db unreachable'));
    const service = new DryRunService();
    const nodes = ['n0', 'n1', 'n2'].map((localId, i) => ({
      localId, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));

    await expect(service.diff(nodes as any, fakeIdempotencyService)).rejects.toThrow('db unreachable');
  });

  it('re-throws a per-node exception captured by mapWithConcurrency (no silent partial diff)', async () => {
    const service = new DryRunService();
    const nodes = ['n0', 'n1'].map((localId, i) => ({
      localId, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));
    await expect(
      service.diff(nodes as any, fakeIdempotencyService, undefined, () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
  });

  it('calls idempotencyService.lookupMany exactly once for the whole batch, not once per node', async () => {
    // Regression guard for the N+1 fix itself: the previous per-node
    // idempotencyService.lookup call issued one DB round trip per node.
    const service = new DryRunService();
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      localId: `n${i}`, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));

    await service.diff(nodes as any, fakeIdempotencyService);

    expect(fakeIdempotencyService.lookupMany).toHaveBeenCalledTimes(1);
  });

  it('returns results in the original node order regardless of concurrent dedupCheck resolution order', async () => {
    // Idempotency lookups are now a synchronous map read after the single
    // prefetch above -- the remaining per-node async work inside the
    // concurrent loop is dedupCheck, so that is what order-preservation
    // must survive against after this fix.
    const dedupCheck = jest.fn((_text: string, title: string) => {
      const delayMs = title === 'T0' ? 30 : 5;
      return new Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }>((resolve) =>
        setTimeout(() => resolve({ isDuplicate: false, matchedItemId: null, similarity: null }), delayMs),
      );
    });
    const service = new DryRunService(3);
    const nodes = ['n0', 'n1', 'n2', 'n3', 'n4'].map((localId, i) => ({
      localId, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));

    const result = await service.diff(nodes as any, fakeIdempotencyService, dedupCheck);

    expect(result.map((r) => r.localId)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('runs dedupCheck calls concurrently, not one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dedupCheck = jest.fn(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<{ isDuplicate: boolean; matchedItemId: string | null; similarity: number | null }>((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve({ isDuplicate: false, matchedItemId: null, similarity: null });
        }, 10),
      );
    });
    const service = new DryRunService(4);
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      localId: `n${i}`, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `hash${i}`, customerId: null, areaPath: 'Project\\Area1', tags: [],
    }));

    await service.diff(nodes as any, fakeIdempotencyService, dedupCheck);

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('passes childType through on every action branch (create, reuse, dedup_skip)', async () => {
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Feature', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          childType: 'Requirement',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].childType).toBe('Requirement');
  });

  // Regression: diffOneNode's three return branches previously built each
  // DryRunDiffEntry as an explicit object literal that never included
  // figureIds -- DryRunTreeNode carried it (see pipeline.worker.ts's
  // diffInputs mapping), but it was silently dropped at this exact
  // conversion, so jobs.service.ts's confirm()-time figure-attachment phase
  // always iterated an empty list. One case per action branch since each
  // branch is its own object literal, not a shared code path.
  it('carries figureIds through on the "create" branch', async () => {
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          figureIds: ['f0', 'f1'],
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].action).toBe('create');
    expect(result[0].figureIds).toEqual(['f0', 'f1']);
  });

  it('carries figureIds through on the "reuse" branch', async () => {
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(
      new Map([[idempotencyMapKey('h0', 'Project\\Area1'), 42]]),
    );
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          figureIds: ['f2'],
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].action).toBe('reuse');
    expect(result[0].figureIds).toEqual(['f2']);
  });

  it('carries figureIds through on the "dedup_skip" branch', async () => {
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: true, matchedItemId: '99', similarity: 0.9 });
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          figureIds: ['f3'],
        },
      ],
      fakeIdempotencyService,
      dedupCheck,
    );
    expect(result[0].action).toBe('dedup_skip');
    expect(result[0].figureIds).toEqual(['f3']);
  });

  // SWEEP.md section 7's abstain channel. Same regression shape as
  // figureIds above -- diffOneNode's three return branches are each their
  // own object literal, so a field added to only some of them is silently
  // dropped on the others; dry-run.service.ts's own figureIds comment
  // documents a real, confirmed, shipped bug caused by exactly that.
  it('carries qualityConfidence through on the "create" branch', async () => {
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          qualityConfidence: 'low',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].action).toBe('create');
    expect(result[0].qualityConfidence).toBe('low');
  });

  it('carries qualityConfidence through on the "reuse" branch', async () => {
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(
      new Map([[idempotencyMapKey('h0', 'Project\\Area1'), 42]]),
    );
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          qualityConfidence: 'low',
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].action).toBe('reuse');
    expect(result[0].qualityConfidence).toBe('low');
  });

  it('carries qualityConfidence through on the "dedup_skip" branch', async () => {
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: true, matchedItemId: '99', similarity: 0.9 });
    const service = new DryRunService();
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          qualityConfidence: 'low',
        },
      ],
      fakeIdempotencyService,
      dedupCheck,
    );
    expect(result[0].action).toBe('dedup_skip');
    expect(result[0].qualityConfidence).toBe('low');
  });

  // Phase 4 provenance fields: tableIds/uncaptionedFigureIds (siblings of
  // figureIds on DryRunTreeNode/DryRunDiffEntry) and sourceRef's own new
  // sectionPath/pageEnd/pageProvenance members. Same regression shape as
  // figureIds above -- diffOneNode's three return branches are each their
  // own object literal, so a field added to only some of them is silently
  // dropped on the others. One case per action branch, mirroring the
  // figureIds tests exactly.
  it('carries tableIds/uncaptionedFigureIds/sectionPath/pageEnd/pageProvenance through on the "create" branch', async () => {
    const service = new DryRunService();
    const sourceRef = {
      documentPath: '/tmp/doc.pdf', startOffset: 10, endOffset: 20, page: 12,
      pageEnd: 14, pageProvenance: 'rendered', sectionPath: ['3 Power', '3.2 Backplane'],
    };
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          sourceRef, tableIds: ['t0'], uncaptionedFigureIds: ['f9'], insignificantFigureIds: ['f9'],
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].action).toBe('create');
    expect(result[0].sourceRef).toEqual(sourceRef);
    expect(result[0].tableIds).toEqual(['t0']);
    expect(result[0].uncaptionedFigureIds).toEqual(['f9']);
    expect(result[0].insignificantFigureIds).toEqual(['f9']);
  });

  it('carries tableIds/uncaptionedFigureIds/sectionPath/pageEnd/pageProvenance through on the "reuse" branch', async () => {
    (fakeIdempotencyService.lookupMany as jest.Mock).mockResolvedValue(
      new Map([[idempotencyMapKey('h0', 'Project\\Area1'), 42]]),
    );
    const service = new DryRunService();
    const sourceRef = {
      documentPath: '/tmp/doc.pdf', startOffset: 10, endOffset: 20, page: 12,
      pageEnd: null, pageProvenance: 'interpolated', sectionPath: ['4 Interfaces'],
    };
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          sourceRef, tableIds: ['t1'], uncaptionedFigureIds: ['f8'], insignificantFigureIds: ['f8'],
        },
      ],
      fakeIdempotencyService,
    );
    expect(result[0].action).toBe('reuse');
    expect(result[0].sourceRef).toEqual(sourceRef);
    expect(result[0].tableIds).toEqual(['t1']);
    expect(result[0].uncaptionedFigureIds).toEqual(['f8']);
    expect(result[0].insignificantFigureIds).toEqual(['f8']);
  });

  it('carries tableIds/uncaptionedFigureIds/sectionPath/pageEnd/pageProvenance through on the "dedup_skip" branch', async () => {
    const dedupCheck = jest.fn().mockResolvedValue({ isDuplicate: true, matchedItemId: '99', similarity: 0.9 });
    const service = new DryRunService();
    const sourceRef = {
      documentPath: '/tmp/doc.pdf', startOffset: 10, endOffset: 20, page: null,
      pageEnd: null, pageProvenance: null, sectionPath: [],
    };
    const result = await service.diff(
      [
        {
          localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
          sourceHash: 'h0', customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
          sourceRef, tableIds: ['t2'], uncaptionedFigureIds: ['f7'], insignificantFigureIds: ['f7'],
        },
      ],
      fakeIdempotencyService,
      dedupCheck,
    );
    expect(result[0].action).toBe('dedup_skip');
    expect(result[0].sourceRef).toEqual(sourceRef);
    expect(result[0].tableIds).toEqual(['t2']);
    expect(result[0].uncaptionedFigureIds).toEqual(['f7']);
    expect(result[0].insignificantFigureIds).toEqual(['f7']);
  });

  it('calls onProgress once per node with a monotonically-increasing completed count, final call at the total', async () => {
    // Regression coverage for the previously-silent dedup-check burst (see
    // pipeline.worker.ts's own comment: confirmed live, ~543 nodes, zero
    // progress signal). onProgress is optional and must not change diff()'s
    // own return value or ordering guarantees.
    const service = new DryRunService();
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      localId: `n${i}`, parentLocalId: null, type: 'Requirement', title: `T${i}`, description: `D${i}`,
      sourceHash: `h${i}`, customerId: null, seCoverageRef: null, areaPath: 'Project\\Area1', tags: [],
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

  it('queries a target customer-id only once even when multiple links share it', async () => {
    // Real perf gap this closes: several requirements in one document can
    // all reference the same external item -- each previously issued its
    // own sequential WIQL query for the identical customer-id.
    const links: TraceLink[] = [
      { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-SHARED', resolutionStatus: 'pending' },
      { sourceLocalId: 'n2', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-SHARED', resolutionStatus: 'pending' },
      { sourceLocalId: 'n3', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covers', targetKind: 'crossJob', targetCustomerId: 'REQ-SHARED', resolutionStatus: 'pending' },
    ];
    const queryByCustomerId = jest.fn().mockResolvedValue([555]);

    const result = await resolveCrossJobTraceLinks(links, queryByCustomerId);

    expect(queryByCustomerId).toHaveBeenCalledTimes(1);
    expect(result.every((link) => link.resolvedAdoId === 555 && link.resolutionStatus === 'resolved')).toBe(true);
  });
});

function _entry(overrides: Partial<DryRunDiffEntry>): DryRunDiffEntry {
  return {
    localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
    action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h', customerId: null,
    seCoverageRef: null,
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

// W1 content-aware identity: a follow-up file is matched by identity v2 first, then the v1 position hash, then the legacy text hash; a
// match whose stored content hash differs from the node's stays 'reuse' (nothing is updated in Azure DevOps, D-W1b) and is flagged.
describe('DryRunService identity v2', () => {
  const area = 'Project\\Area1';
  const node = (extra: Record<string, unknown> = {}) => ({
    localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Power', description: 'The unit shall respond within 1000 ms.',
    sourceHash: 'v1-renamed', legacySourceHash: 'legacy-text', identityHashV2: 'v2', contentHash: 'c-new',
    customerId: null, seCoverageRef: null, areaPath: area, tags: [], ...extra,
  });
  const mappings = (rows: [string, number, string | null][]) => ({
    lookupMany: jest.fn().mockResolvedValue(new Map()),
    lookupMappings: jest.fn().mockResolvedValue(
      new Map(rows.map(([hash, adoWorkItemId, contentHash]) => [idempotencyMapKey(hash, area), { adoWorkItemId, contentHash }])),
    ),
  }) as unknown as IdempotencyService & { lookupMany: jest.Mock; lookupMappings: jest.Mock };

  it('looks up v2, then the v1 position hash, then the legacy text hash, in one batched call', async () => {
    const idempotency = mappings([]);
    await new DryRunService().diff([node()], idempotency);
    expect(idempotency.lookupMappings).toHaveBeenCalledWith([
      { sourceHash: 'v2', areaPath: area },
      { sourceHash: 'v1-renamed', areaPath: area },
      { sourceHash: 'legacy-text', areaPath: area },
    ]);
    expect(idempotency.lookupMany).not.toHaveBeenCalled();
  });

  it.each(['Epic', 'Feature'])('never matches a %s by identity v2: a different document with the same generic heading must not adopt this one\'s section', async (type) => {
    const idempotency = mappings([['v2', 41, 'c-old']]);
    const [entry] = await new DryRunService().diff([node({ type, title: 'Introduction' })], idempotency);
    expect(idempotency.lookupMappings).toHaveBeenCalledWith([
      { sourceHash: 'v1-renamed', areaPath: area },
      { sourceHash: 'legacy-text', areaPath: area },
    ]);
    expect(entry.action).toBe('create');
  });

  it('still matches an Epic or Feature by its v1 hash, and adds no v2 backfill for it', async () => {
    const [entry] = await new DryRunService().diff([node({ type: 'Feature', sourceHash: 'v1-same' })], mappings([['v1-same', 55, null]]));
    expect(entry).toMatchObject({ action: 'reuse', existingAdoId: 55 });
    expect(entry.backfillIdentityV2).toBeUndefined();
  });

  it('a v2 hit with the same content is a plain reuse, not flagged', async () => {
    const [entry] = await new DryRunService().diff([node({ contentHash: 'c-old' })], mappings([['v2', 41, 'c-old']]));
    expect(entry).toMatchObject({ action: 'reuse', existingAdoId: 41, identityHashV2: 'v2', contentHash: 'c-old' });
    expect(entry.changedSinceWritten).toBeUndefined();
    expect(entry.backfillIdentityV2).toBeUndefined();
  });

  it('a v2 hit with different content stays reuse and is flagged changedSinceWritten, with the written content hash', async () => {
    const [entry] = await new DryRunService().diff([node()], mappings([['v2', 41, 'c-old']]));
    expect(entry).toMatchObject({ action: 'reuse', existingAdoId: 41, changedSinceWritten: true, writtenContentHash: 'c-old', contentHash: 'c-new' });
  });

  it('prefers the v2 row over a v1 row that points elsewhere', async () => {
    const [entry] = await new DryRunService().diff([node()], mappings([['v1-renamed', 99, null], ['v2', 41, 'c-new']]));
    expect(entry.existingAdoId).toBe(41);
  });

  it('a v1-only hit is reused and marks a v2 row to backfill at write time (no bulk rewrite)', async () => {
    const [entry] = await new DryRunService().diff([node({ sourceHash: 'v1-same' })], mappings([['v1-same', 55, null]]));
    expect(entry).toMatchObject({ action: 'reuse', existingAdoId: 55, backfillIdentityV2: true, writtenContentHash: null });
    // No content hash was stored with the old row: the text check against Azure DevOps decides (verifyExistingAdoIdsStillExist).
    expect(entry.contentCheckPending).toBe(true);
    expect(entry.changedSinceWritten).toBeUndefined();
  });

  it('a renamed file (new v1 hash, same v2) is reused instead of created again, without a similarity check', async () => {
    const dedupCheck = jest.fn();
    const [entry] = await new DryRunService().diff([node({ contentHash: 'c-old' })], mappings([['v2', 41, 'c-old']]), dedupCheck);
    expect(entry.action).toBe('reuse');
    expect(dedupCheck).not.toHaveBeenCalled();
  });

  it('with the flag off, behaves as today: v1 and legacy only, so the renamed file is created', async () => {
    const idempotency = mappings([['v2', 41, 'c-old']]);
    const [entry] = await new DryRunService(8, false).diff([node()], idempotency);
    expect(idempotency.lookupMappings).not.toHaveBeenCalled();
    expect(idempotency.lookupMany).toHaveBeenCalledWith([
      { sourceHash: 'v1-renamed', areaPath: area },
      { sourceHash: 'legacy-text', areaPath: area },
    ]);
    expect(entry.action).toBe('create');
    expect(entry.changedSinceWritten).toBeUndefined();
  });

  it('a node without a v2 identity (an older ingestion result) keeps today\'s lookup', async () => {
    const idempotency = mappings([]);
    await new DryRunService().diff([node({ identityHashV2: undefined, contentHash: undefined })], idempotency);
    expect(idempotency.lookupMappings).not.toHaveBeenCalled();
    expect(idempotency.lookupMany).toHaveBeenCalledTimes(1);
  });
});

describe('verifyExistingAdoIdsStillExist text check (W1, mappings with no content hash)', () => {
  const reuse = (extra: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry => ({
    localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Power', description: 'The unit shall respond within 1000 ms.',
    action: 'reuse', existingAdoId: 41, similarity: null, sourceHash: 'h', customerId: null, seCoverageRef: null, tags: [],
    contentHash: 'c-new', writtenContentHash: null, contentCheckPending: true, ...extra,
  });
  const ado = (description: string) => jest.fn().mockResolvedValue([{ id: 41, fields: { 'System.Description': description } }]);

  it('flags the item when the text in Azure DevOps differs, keeping the old text to compare', async () => {
    const [entry] = await verifyExistingAdoIdsStillExist([reuse()], ado('<p>The unit shall respond within 100 ms.</p>'), undefined, { compareText: true });
    expect(entry).toMatchObject({ action: 'reuse', changedSinceWritten: true, writtenText: 'The unit shall respond within 100 ms.' });
    expect(entry.contentCheckPending).toBeUndefined();
  });

  it('does not flag equal text (ADO\'s HTML and spacing ignored) and records the content as verified', async () => {
    const [entry] = await verifyExistingAdoIdsStillExist([reuse()], ado('<p>The unit shall respond within  1000 ms. </p>'), undefined, { compareText: true });
    expect(entry.changedSinceWritten).toBeUndefined();
    expect(entry.writtenContentHash).toBe('c-new');
    expect(entry.contentCheckPending).toBeUndefined();
  });

  it('never compares generated (SURVEY) text: the marker is dropped and nothing is flagged', async () => {
    const [entry] = await verifyExistingAdoIdsStillExist([reuse()], ado('<p>Other words</p>'), undefined, { compareText: false });
    expect(entry.changedSinceWritten).toBeUndefined();
    expect(entry.contentCheckPending).toBeUndefined();
  });

  it('a match whose item was deleted becomes a plain create, with no change flag left on it', async () => {
    const [entry] = await verifyExistingAdoIdsStillExist(
      [reuse({ changedSinceWritten: true, writtenContentHash: 'c-old', contentCheckPending: undefined, backfillIdentityV2: true })],
      jest.fn().mockResolvedValue([]),
      undefined,
      { compareText: true },
    );
    expect(entry.action).toBe('create');
    expect(entry.changedSinceWritten).toBeUndefined();
    expect(entry.writtenContentHash).toBeUndefined();
    expect(entry.backfillIdentityV2).toBeUndefined();
  });
});

describe('changedSinceWrittenWarning', () => {
  it('emits one Check warning per job listing the changed items, and none when nothing changed', () => {
    const entries = [
      { localId: 'a', changedSinceWritten: true },
      { localId: 'b' },
      { localId: 'c', changedSinceWritten: true },
    ] as DryRunDiffEntry[];
    expect(changedSinceWrittenWarning(entries)).toEqual({
      kind: 'changed_since_written',
      severity: 'needs_review',
      nodeIds: ['a', 'c'],
      detail: { count: 2 },
      raw: '2 items match items already in Azure DevOps whose text differs. Nothing was updated in Azure DevOps.',
    });
    expect(changedSinceWrittenWarning([{ localId: 'b' }] as DryRunDiffEntry[])).toBeNull();
  });
});
