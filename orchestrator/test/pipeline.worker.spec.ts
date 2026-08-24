import { runPipelineJob } from '../src/modules/pipeline/pipeline.worker';

describe('runPipelineJob', () => {
  const fakeIngestionClient = { ingest: jest.fn(), level: jest.fn(), checkDuplicate: jest.fn(), deleteDedupEntry: jest.fn() };
  const fakeDryRunService = { diff: jest.fn() };
  const fakeIdempotencyService = { lookup: jest.fn(), record: jest.fn(), deleteByAdoWorkItemId: jest.fn() };
  const fakePrisma = {
    // findUnique backs assertNotCancelled's cooperative-cancellation
    // checkpoints -- defaults to 'running' (never cancelled) so every
    // existing test's happy/failure path is unaffected; the dedicated
    // cancellation describe block below overrides this per-test.
    job: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ status: 'running' }) },
    auditEntry: { create: jest.fn() },
    dedupSkipAudit: { createMany: jest.fn() },
    jobFigureFile: { deleteMany: jest.fn() },
    // Defaults to "recently backfilled" (findUnique resolves a fresh
    // lastBackfilledAt) so maybeBackfillAreaPath is a no-op for every
    // existing test's happy/failure path -- the dedicated area-path
    // backfill describe block below overrides this per-test.
    areaPathBackfill: {
      findUnique: jest.fn().mockResolvedValue({ areaPath: 'Project\\Area1', lastBackfilledAt: new Date() }),
      upsert: jest.fn(),
    },
  };
  const fakeJobEventsPublisher = { publish: jest.fn() };
  const fakeMcpClient = {
    discoverLinkTypes: jest.fn().mockResolvedValue([]),
    discoverFields: jest.fn().mockResolvedValue([]),
    queryIds: jest.fn().mockResolvedValue([]),
    getWorkItemsBatch: jest.fn().mockResolvedValue([]),
  };
  const fakeBackfillService = { backfillAreaPath: jest.fn().mockResolvedValue({ scanned: 0, seeded: 0, skipped: 0, skippedReasons: {} }) };
  const fakeAdoCredentialResolver = { resolve: jest.fn().mockResolvedValue(undefined) };
  // Phase 6c primer deps -- both optional on PipelineWorkerDeps, so every
  // existing test above/below that omits them entirely is unaffected
  // (primerContext just stays undefined, /level's exact pre-Phase-6c
  // behavior). Only the dedicated describe block below wires them in.
  const fakeOpenWebUiClient = {
    uploadFile: jest.fn(),
    pollFileProcessed: jest.fn(),
    chatWithFullFileContext: jest.fn(),
    deleteFile: jest.fn(),
  };
  const fakePrimerCacheRedis = { get: jest.fn(), set: jest.fn() };

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
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from('text'), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.ingest).toHaveBeenCalledWith(Buffer.from('text'), 'x.txt', false, 'baseline', 'job-1', undefined);
    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [{ id: 'b0' }] }, 'CUST-1', 'baseline', undefined, [], 'gemma4:12b', 'job-1', undefined);
    expect(result).toEqual([{ localId: 'n0', action: 'create', existingAdoId: null }]);
  });

  it('throws when a node has neither identity_hash nor fidelity_hash (cannot compute a stable sourceHash)', async () => {
    // Regression guard for a type-honesty bug found while wiring S10's
    // generated WorkItemTree type in: this code previously assumed
    // fidelity_hash was always a non-null string (the local LeveledNode
    // type said so), when the real contract (shared/schemas/work-item-tree.
    // schema.json) says it's null for every SURVEY node. In practice
    // identity_hash always backs SURVEY nodes, so this case shouldn't be
    // reachable today -- but if ingestion ever regresses and sends neither,
    // this must fail loudly rather than let `undefined` silently reach
    // DryRunTreeNode.sourceHash and corrupt the idempotency lookup.
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [{ local_id: 'n0', fidelity_hash: null, customer_id: null }],
    });

    await expect(
      runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
        },
      ),
    ).rejects.toThrow(/n0.*neither identity_hash nor fidelity_hash/);
  });

  it('passes job.mode through to ingestionClient.level', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', undefined);
  });

  it('filters Hierarchy-Forward/Reverse out of the trace-link catalog but keeps every other real link type', async () => {
    // Regression: Hierarchy-Forward/Reverse ("Child"/"Parent") are real ADO
    // work-item relation types (they pass discoverLinkTypes' own
    // isWorkItemRelationType filter), but trace-link inference exists to
    // find relationships the hierarchy doesn't already express -- the
    // model was redundantly proposing "Parent -> br0_n1" for nearly every
    // node since the hierarchy is already fully captured by
    // parent_local_id, cluttering the diff view with links that state
    // nothing new.
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);
    fakeMcpClient.discoverLinkTypes.mockResolvedValueOnce([
      { referenceName: 'System.LinkTypes.Hierarchy-Forward', name: 'Child' },
      { referenceName: 'System.LinkTypes.Hierarchy-Reverse', name: 'Parent' },
      { referenceName: 'System.LinkTypes.Related', name: 'Related' },
      { referenceName: 'Microsoft.VSTS.Common.TestedBy-Forward', name: 'Tested By' },
    ]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith(
      { blocks: [] },
      null,
      'survey',
      undefined,
      [
        { referenceName: 'System.LinkTypes.Related', name: 'Related' },
        { referenceName: 'Microsoft.VSTS.Common.TestedBy-Forward', name: 'Tested By' },
      ],
      'gemma4:12b',
      'job-1',
      undefined,
    );
  });

  it('updates the Job row status to diff_ready and stores the diff on success', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'diff_ready',
        dryRunDiff: [],
        warnings: [],
        kbCitations: [],
        figureDescriptions: [],
        tableDescriptions: [],
        // Backward-compat default: the mocked level() response has neither
        // `excluded_figure_ids` nor `excluded_table_ids` at all, same `?? []`
        // guard as figureDescriptions/kbCitations above.
        excludedFigureIds: [],
        excludedTableIds: [],
        // ETA telemetry write path (DESIGN.md §11.2.3.b) -- blockCount/
        // figureCount default to 0 here since the mocked ingest() response
        // has neither `blocks` nor `figures` populated (both fall through
        // the `?? []` guard).
        blockCount: 0,
        figureCount: 0,
        diffReadyAt: expect.any(Date),
      },
    });
  });

  it('sets Job status to running before publishing the parse stage event', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    // ETA telemetry write path (DESIGN.md §11.2.3.b) -- model is null here
    // because this job's mode is 'baseline', which never calls an LLM at
    // all; a SURVEY job would record the effective model instead.
    expect(fakePrisma.job.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'job-1' },
      data: { status: 'running', startedAt: expect.any(Date), model: null },
    });
    expect(fakeJobEventsPublisher.publish).toHaveBeenNthCalledWith(1, 'job-1', 'parse');
  });

  it('sets Job status to failed and rethrows if ingestion fails', async () => {
    fakeIngestionClient.ingest.mockRejectedValue(new Error('ingestion service down'));

    await expect(
      runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
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
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        {
          localId: 'n0', sourceHash: 'hashA', legacySourceHash: 'hashA', customerId: 'CUST-1', areaPath: 'Project\\Area1',
          groundingScore: null, sourceRef: null, tags: [], traceLinks: [], figureIds: [],
          tableIds: [], uncaptionedFigureIds: [], insignificantFigureIds: [],
        },
        {
          localId: 'n1', sourceHash: 'hashB', legacySourceHash: 'hashB', customerId: 'CUST-1', areaPath: 'Project\\Area1',
          groundingScore: null, sourceRef: null, tags: [], traceLinks: [], figureIds: [],
          tableIds: [], uncaptionedFigureIds: [], insignificantFigureIds: [],
        },
      ],
      fakeIdempotencyService,
      expect.any(Function),
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
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
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
          legacySourceHash: 'hashA',
          customerId: 'CUST-1',
          areaPath: 'Project\\Area1',
          groundingScore: null,
          sourceRef: null,
          tags: [],
          traceLinks: [],
          figureIds: [],
          tableIds: [], uncaptionedFigureIds: [], insignificantFigureIds: [],
        },
        {
          localId: 'n1',
          parentLocalId: 'n0',
          type: 'Requirement',
          title: 'Child Title',
          description: 'Child Desc',
          sourceHash: 'hashB',
          legacySourceHash: 'hashB',
          customerId: 'CUST-1',
          areaPath: 'Project\\Area1',
          groundingScore: null,
          sourceRef: null,
          tags: [],
          traceLinks: [],
          figureIds: [],
          tableIds: [], uncaptionedFigureIds: [], insignificantFigureIds: [],
        },
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('carries quality_score/quality_issues/child_type from ingestion through to the dry-run diff input', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
          quality_score: 72,
          quality_issues: ['vague_term'],
          quality_category_scores: { clarity: 40, testability: 80, atomicity: 90, style: 60, rationale: 20 },
          child_type: 'Requirement',
        },
        {
          local_id: 'n1',
          fidelity_hash: 'hashB',
          customer_id: 'CUST-1',
        },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        {
          localId: 'n0', sourceHash: 'hashA', legacySourceHash: 'hashA', customerId: 'CUST-1', areaPath: 'Project\\Area1',
          groundingScore: null, sourceRef: null, tags: [],
          qualityScore: 72, qualityIssues: ['vague_term'],
          qualityCategoryScores: { clarity: 40, testability: 80, atomicity: 90, style: 60, rationale: 20 },
          childType: 'Requirement', traceLinks: [], figureIds: [],
          tableIds: [], uncaptionedFigureIds: [], insignificantFigureIds: [],
        },
        {
          localId: 'n1', sourceHash: 'hashB', legacySourceHash: 'hashB', customerId: 'CUST-1', areaPath: 'Project\\Area1',
          groundingScore: null, sourceRef: null, tags: [],
          qualityScore: undefined, qualityIssues: undefined, qualityCategoryScores: undefined,
          childType: undefined, traceLinks: [], figureIds: [],
          tableIds: [], uncaptionedFigureIds: [], insignificantFigureIds: [],
        },
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  // Regression guard for a stale type: quality_category_scores was once
  // declared as a fixed {clarity,testability,atomicity,style,rationale}
  // object here even though every other layer (dry-run.service.ts,
  // DiffTree.tsx, QualityGauge.tsx) already treats it as a dynamic
  // Record<string, number> -- an org's own ingested KB checklist can define
  // entirely different category names (e.g. "Necessary"/"Verifiable").
  // Compiled fine before the fix only because the fixed shape happened to
  // be structurally assignable; this proves a KB-derived key set survives
  // the mapping unchanged, not just the fixed 5-dimension fallback.
  it('carries a KB-derived (non-fixed-5-dimension) quality_category_scores key set through unchanged', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1',
          quality_score: 85, quality_issues: [],
          quality_category_scores: { Necessary: 90, Verifiable: 80 },
        },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({ qualityCategoryScores: { Necessary: 90, Verifiable: 80 } }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('carries quality_category_checklist from ingestion through to the dry-run diff input, mapped to camelCase', async () => {
    // Companion to quality_category_scores -- see ingestion's
    // quality_category_checklist docstring (app.workitem.model). Only a
    // SUBSET of the score keys is expected to have a matched definition
    // (Verifiable has none here), which is the real, common case, not a
    // partial-failure signal.
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1',
          quality_score: 85, quality_issues: [],
          quality_category_scores: { Necessary: 90, Verifiable: 80 },
          quality_category_checklist: { Necessary: 'States something not already satisfied.' },
        },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          qualityCategoryChecklist: { Necessary: 'States something not already satisfied.' },
        }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('carries figure_ids from ingestion through to the dry-run diff input', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        { local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1', figure_ids: ['f0', 'f2'] },
        { local_id: 'n1', fidelity_hash: 'hashB', customer_id: 'CUST-1' },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({ localId: 'n0', figureIds: ['f0', 'f2'] }),
        expect.objectContaining({ localId: 'n1', figureIds: [] }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('prunes JobFigureFile rows for figures no node references, once the real tree is known', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        { local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1', figure_ids: ['f0'] },
        { local_id: 'n1', fidelity_hash: 'hashB', customer_id: 'CUST-1', figure_ids: ['f2'] },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.jobFigureFile.deleteMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', figureId: { notIn: ['f0', 'f2'] } },
    });
  });

  it('a JobFigureFile prune failure never fails the job -- best-effort cleanup only', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [{ local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1', figure_ids: ['f0'] }],
    });
    fakeDryRunService.diff.mockResolvedValue([]);
    fakePrisma.jobFigureFile.deleteMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
        },
      ),
    ).resolves.not.toThrow();
    expect(fakePrisma.job.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'diff_ready' }) }));
  });

  it('carries grounding_score from ingestion through when present', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
          grounding_score: 0.15,
          quality_score: 40,
          quality_issues: ['ambiguous', 'vague_term'],
        },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          localId: 'n0',
          groundingScore: 0.15,
          qualityScore: 40,
          qualityIssues: ['ambiguous', 'vague_term'],
        }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('carries source_ref/tags from ingestion through to the dry-run diff input, and persists tree-level warnings onto the Job row', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
          source_ref: { document_path: '/tmp/doc.docx', start_offset: 10, end_offset: 20, page: null },
          tags: ['functional', 'safety'],
        },
      ],
      warnings: [
        {
          kind: 'zero_nodes',
          severity: 'pipeline_issue',
          node_ids: [],
          detail: { blockCount: 5 },
          raw: 'SURVEY node count (1) diverges from source block count (5) by more than 50%',
        },
      ],
      excluded_figure_ids: ['fig-1', 'fig-2'],
      excluded_table_ids: ['tbl-1'],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          localId: 'n0',
          sourceRef: {
            documentPath: '/tmp/doc.docx', startOffset: 10, endOffset: 20, page: null,
            pageEnd: null, pageProvenance: null, sectionPath: [],
          },
          tags: ['functional', 'safety'],
        }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'diff_ready',
        dryRunDiff: [],
        warnings: [
          {
            kind: 'zero_nodes',
            severity: 'pipeline_issue',
            nodeIds: [],
            detail: { blockCount: 5 },
            raw: 'SURVEY node count (1) diverges from source block count (5) by more than 50%',
          },
        ],
        kbCitations: [],
        figureDescriptions: [],
        tableDescriptions: [],
        // Doc-wide ids the mapping stage judged decorative/irrelevant, or
        // that failed mapping (see Job.excludedTableIds' schema.prisma doc
        // comment) -- populated from the tree-level excluded_figure_ids/
        // excluded_table_ids fields above.
        excludedFigureIds: ['fig-1', 'fig-2'],
        excludedTableIds: ['tbl-1'],
        blockCount: 0,
        figureCount: 0,
        diffReadyAt: expect.any(Date),
      },
    });
  });

  // Phase 4 provenance fields: sectionPath/pageEnd/pageProvenance
  // (source_ref) and tableIds/uncaptionedFigureIds (top-level, siblings of
  // figure_ids) -- ingestion now populates real values for these on every
  // scored WorkItemNode, threaded through the exact same raw-to-diff-input
  // mapping figureIds/sourceRef already take (see LeveledSourceRef/
  // LeveledNode above).
  it('carries source_ref.page_end/page_provenance/section_path and table_ids/uncaptioned_figure_ids through to the dry-run diff input', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
          source_ref: {
            document_path: '/tmp/doc.pdf', start_offset: 10, end_offset: 20, page: 12,
            page_end: 14, page_provenance: 'rendered', section_path: ['3 Power', '3.2 Backplane'],
          },
          table_ids: ['t0', 't1'],
          uncaptioned_figure_ids: ['f9'],
        },
        // Omits every new field entirely -- must default exactly like
        // figure_ids does (page_end/page_provenance null, section_path/
        // table_ids/uncaptioned_figure_ids []), never crash the mapping.
        { local_id: 'n1', fidelity_hash: 'hashB', customer_id: 'CUST-1' },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          localId: 'n0',
          sourceRef: {
            documentPath: '/tmp/doc.pdf', startOffset: 10, endOffset: 20, page: 12,
            pageEnd: 14, pageProvenance: 'rendered', sectionPath: ['3 Power', '3.2 Backplane'],
          },
          tableIds: ['t0', 't1'],
          uncaptionedFigureIds: ['f9'],
        }),
        expect.objectContaining({ localId: 'n1', tableIds: [], uncaptionedFigureIds: [] }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  // Task 4b sub-fix (ii): insignificant_figure_ids is a SUBSET of
  // uncaptioned_figure_ids -- carried through the same raw-node ->
  // DryRunTreeNode mapping figureIds/uncaptionedFigureIds already take (see
  // pipeline.worker.ts's diffInputs map).
  it('carries insignificant_figure_ids through to the dry-run diff input, as a subset of uncaptioned_figure_ids', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        {
          local_id: 'n0',
          fidelity_hash: 'hashA',
          customer_id: 'CUST-1',
          uncaptioned_figure_ids: ['f9', 'f10'],
          insignificant_figure_ids: ['f9'],
        },
        // Omits insignificant_figure_ids entirely -- must default to [],
        // same convention as every other optional array field here.
        { local_id: 'n1', fidelity_hash: 'hashB', customer_id: 'CUST-1', uncaptioned_figure_ids: ['f11'] },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          localId: 'n0',
          uncaptionedFigureIds: ['f9', 'f10'],
          insignificantFigureIds: ['f9'],
        }),
        expect.objectContaining({ localId: 'n1', uncaptionedFigureIds: ['f11'], insignificantFigureIds: [] }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('prune-bug fix: an empty referenced-figures list (no node references any figure) results in ZERO deletions, not everything deleted', async () => {
    // Regression guard: Prisma's `notIn: []` matches EVERY row, so before
    // this fix a job where no node referenced any figure at all would wipe
    // every JobFigureFile row for the job instead of leaving them untouched.
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [{ local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1' }],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.jobFigureFile.deleteMany).not.toHaveBeenCalled();
  });

  it('prune union: referencedFigureIds is the union of figureIds AND uncaptionedFigureIds across all nodes', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [
        { local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1', figure_ids: ['f0'], uncaptioned_figure_ids: ['f9'] },
        { local_id: 'n1', fidelity_hash: 'hashB', customer_id: 'CUST-1', figure_ids: ['f2'] },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.jobFigureFile.deleteMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', figureId: { notIn: ['f0', 'f9', 'f2'] } },
    });
  });

  it('prune union: a captioned figure excluded from every node (Stage-2 decorative mapping) is still kept, since figureDescriptions still promises an image for it', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({
      blocks: [],
      figures: [
        { id: 'f0', caption: 'A block diagram showing power distribution.' },
        { id: 'f1', caption: null },
        { id: 'f2', caption: 'Excluded as decorative, but still captioned.' },
      ],
    });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [{ local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1', figure_ids: ['f0'] }],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.jobFigureFile.deleteMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', figureId: { notIn: ['f0', 'f2'] } },
    });
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
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    const dedupCheckArg = fakeDryRunService.diff.mock.calls[0][2];
    await dedupCheckArg('Desc 0', 'Title 0', 'Project\\Area1');
    expect(fakeIngestionClient.checkDuplicate).toHaveBeenCalledWith('Desc 0', 'Title 0', 'Project\\Area1');
  });

  it('always supplies the dedupCheck callback even when job.followUp is false -- deciding whether a work item already exists is a required step, not opt-in', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [{ local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1' }],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: false },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    const dedupCheckArg = fakeDryRunService.diff.mock.calls[0][2];
    expect(dedupCheckArg).toBeDefined();
    await dedupCheckArg('Desc 0', 'Title 0', 'Project\\Area1');
    expect(fakeIngestionClient.checkDuplicate).toHaveBeenCalledWith('Desc 0', 'Title 0', 'Project\\Area1');
  });

  it('always supplies the dedupCheck callback when job.followUp is unset (older/mocked job predating this field)', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [{ local_id: 'n0', fidelity_hash: 'hashA', customer_id: 'CUST-1' }],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff.mock.calls[0][2]).toBeDefined();
  });

  it('publishes parse, infer_hierarchy_start, generate_requirements_done, and diff_ready in order', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeJobEventsPublisher.publish.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      'parse',
      'infer_hierarchy_start',
      'generate_requirements_done',
      'dedup_check',
      'diff_ready',
    ]);
  });

  it('publishes failed if the pipeline throws', async () => {
    fakeIngestionClient.ingest.mockRejectedValue(new Error('ingestion service down'));

    await expect(
      runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
        },
      ),
    ).rejects.toThrow('ingestion service down');

    expect(fakeJobEventsPublisher.publish.mock.calls.map((call: unknown[]) => call[1])).toEqual(['parse', 'failed']);
  });

  it('passes job.userId (KB scope, NOT job.areaPath) through to ingestionClient.level as the 4th argument', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: 'user-descriptor-1', customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', 'user-descriptor-1', [], 'gemma4:12b', 'job-1', undefined);
  });

  it('passes undefined (not null) to ingestionClient.level when job.userId is null', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', undefined);
  });

  it("passes job.model through to ingestionClient.level as the 6th argument", async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt', model: 'qwen2.5:1.5b' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'qwen2.5:1.5b', 'job-1', undefined);
  });

  it('passes job.id through to ingestionClient.level as the 7th argument (SURVEY narration threading)', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-xyz', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-xyz', undefined);
  });

  it("persists the tree's kb_citations onto the Job row alongside dryRunDiff, mapped to camelCase", async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({
      nodes: [],
      kb_citations: [
        { source_file: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' },
        { source_file: 'doc-b.pdf', similarity: 0.7, relevance: 'unknown' },
      ],
    });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'diff_ready',
        dryRunDiff: [],
        warnings: [],
        kbCitations: [
          { sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' },
          { sourceFile: 'doc-b.pdf', similarity: 0.7, relevance: 'unknown' },
        ],
        figureDescriptions: [],
        tableDescriptions: [],
        excludedFigureIds: [],
        excludedTableIds: [],
        blockCount: 0,
        figureCount: 0,
        diffReadyAt: expect.any(Date),
      },
    });
  });

  it("extracts figures with a real caption or name from ingestion's /ingest response and persists them 1-based by array position", async () => {
    fakeIngestionClient.ingest.mockResolvedValue({
      blocks: [],
      figures: [
        { id: 'fig-a', caption: 'A block diagram showing power distribution.', name: null },
        { id: 'fig-b', caption: null, name: null },
        { id: 'fig-c', caption: 'A wiring harness cross-section.', name: 'Wiring Harness' },
        { id: 'fig-d', caption: null, name: 'Panel Layout Diagram' },
      ],
    });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        // fig-b (no caption AND no name) is dropped -- nothing to show, same
        // rule live SSE narration already applies. fig-d (a name but no
        // caption -- Task 5's widened filter) is KEPT, proving the filter
        // is "caption OR name", not "caption only". Every kept entry keeps
        // its own array-position index (1/3/4), not re-numbered after
        // fig-b drops.
        figureDescriptions: [
          { figureIndex: 1, figureId: 'fig-a', name: null, caption: 'A block diagram showing power distribution.' },
          { figureIndex: 3, figureId: 'fig-c', name: 'Wiring Harness', caption: 'A wiring harness cross-section.' },
          { figureIndex: 4, figureId: 'fig-d', name: 'Panel Layout Diagram', caption: null },
        ],
      }),
    });
  });

  it("extracts tables with a real caption from ingestion's /ingest response, keyed by the table's own id", async () => {
    fakeIngestionClient.ingest.mockResolvedValue({
      blocks: [],
      tables: [
        { id: 't0', caption: 'Summary of CubeADCS Variants' },
        { id: 't1', caption: null },
        { id: 't2', caption: 'Harness Details' },
      ],
    });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        // t1 (no real caption) is dropped -- nothing to show, same rule
        // figureDescriptions already applies. Keyed by tableId, not a
        // 1-based array position -- a table chip already has the real id.
        tableDescriptions: [
          { tableId: 't0', caption: 'Summary of CubeADCS Variants' },
          { tableId: 't2', caption: 'Harness Details' },
        ],
      }),
    });
  });

  it('writes one DedupSkipAudit row per dedup_skip diff entry', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([
      { localId: 'n0', action: 'create', existingAdoId: null, similarity: null },
      { localId: 'n1', action: 'dedup_skip', existingAdoId: 42, similarity: 0.95 },
      { localId: 'n2', action: 'dedup_skip', existingAdoId: 43, similarity: 0.91 },
    ]);
    // Both matched ids confirmed still real in ADO -- verifyExistingAdoIdsStillExist
    // must leave these two dedup_skip entries untouched, same as before that
    // verification step existed.
    fakeMcpClient.getWorkItemsBatch.mockResolvedValueOnce([{ id: 42 }, { id: 43 }]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.dedupSkipAudit.createMany).toHaveBeenCalledWith({
      data: [
        { jobId: 'job-1', localId: 'n1', similarity: 0.95, existingAdoId: 42 },
        { jobId: 'job-1', localId: 'n2', similarity: 0.91, existingAdoId: 43 },
      ],
    });
  });

  it('does not call dedupSkipAudit.createMany when there are no dedup_skip entries', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([{ localId: 'n0', action: 'create', existingAdoId: null, similarity: null }]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.dedupSkipAudit.createMany).not.toHaveBeenCalled();
  });

  it("downgrades a reuse/dedup_skip match to create when verifyExistingAdoIdsStillExist proves the ADO item was deleted, and cleans up the stale IdempotencyMapping row for the downgraded reuse entry", async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([
      { localId: 'n0', action: 'reuse', existingAdoId: 533, similarity: null }, // WI-533: deleted in ADO
      { localId: 'n1', action: 'dedup_skip', existingAdoId: 999, similarity: 0.93 }, // also deleted
      { localId: 'n2', action: 'reuse', existingAdoId: 42, similarity: null }, // still real
    ]);
    // Only 42 comes back -- 533 and 999 are confirmed gone.
    fakeMcpClient.getWorkItemsBatch.mockResolvedValueOnce([{ id: 42 }]);

    const result = await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(result).toEqual([
      { localId: 'n0', action: 'create', existingAdoId: null, similarity: null },
      { localId: 'n1', action: 'create', existingAdoId: null, similarity: null },
      { localId: 'n2', action: 'reuse', existingAdoId: 42, similarity: null },
    ]);
    // Both downgraded entries get their stale match cleaned up: the reuse
    // entry (n0/533) via IdempotencyMapping deletion, the dedup_skip entry
    // (n1/999) via its Chroma vector entry -- the still-real entry (n2/42)
    // was never touched.
    expect(fakeIdempotencyService.deleteByAdoWorkItemId).toHaveBeenCalledTimes(1);
    expect(fakeIdempotencyService.deleteByAdoWorkItemId).toHaveBeenCalledWith(533);
    expect(fakeIngestionClient.deleteDedupEntry).toHaveBeenCalledTimes(1);
    expect(fakeIngestionClient.deleteDedupEntry).toHaveBeenCalledWith('999', 'Project\\Area1');
  });

  it('persists a structured ado_verification_failed WarningRecord (not a bare string) when verifyExistingAdoIdsStillExist itself throws', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([
      { localId: 'n0', action: 'reuse', existingAdoId: 533, similarity: null },
    ]);
    fakeMcpClient.getWorkItemsBatch.mockRejectedValueOnce(new Error('ADO unreachable'));

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          warnings: [
            expect.objectContaining({
              kind: 'ado_verification_failed',
              severity: 'pipeline_issue',
              nodeIds: [],
              raw: expect.stringContaining('ADO unreachable'),
            }),
          ],
        }),
      }),
    );
  });

  it('persists a structured figure_storage_failed WarningRecord when /ingest reports failed_figure_storage_ids', async () => {
    // Storage happens during /ingest, not /level -- a failed figureId can
    // never come back as one of tree.warnings (those only ever originate
    // from /level's response), so this is the orchestrator's own synthesis,
    // mirroring ado_verification_failed's precedent above.
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [], failed_figure_storage_ids: ['f12', 'f45'] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([]);

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          warnings: [
            expect.objectContaining({
              kind: 'figure_storage_failed',
              severity: 'pipeline_issue',
              nodeIds: [],
              detail: { figureIds: ['f12', 'f45'] },
              raw: expect.stringContaining('f12'),
            }),
          ],
        }),
      }),
    );
  });

  it('never fails the job when the stale-mapping cleanup call itself throws', async () => {
    fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
    fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
    fakeDryRunService.diff.mockResolvedValue([
      { localId: 'n0', action: 'reuse', existingAdoId: 533, similarity: null },
      { localId: 'n1', action: 'dedup_skip', existingAdoId: 999, similarity: 0.93 },
    ]);
    fakeMcpClient.getWorkItemsBatch.mockResolvedValueOnce([]);
    fakeIdempotencyService.deleteByAdoWorkItemId.mockRejectedValueOnce(new Error('DB unreachable'));
    fakeIngestionClient.deleteDedupEntry.mockRejectedValueOnce(new Error('Ingestion unreachable'));

    const result = await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
        backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(result).toEqual([
      { localId: 'n0', action: 'create', existingAdoId: null, similarity: null },
      { localId: 'n1', action: 'create', existingAdoId: null, similarity: null },
    ]);
    expect(fakePrisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'diff_ready' }) }),
    );
  });

  describe('cooperative cancellation', () => {
    it('stops right after level() resolves when the job was cancelled while running, without persisting a diff or setting status to failed', async () => {
      fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
      fakeIngestionClient.level.mockResolvedValue({ nodes: [{ local_id: 'n0', fidelity_hash: 'h', customer_id: null }] });
      fakePrisma.job.findUnique.mockResolvedValue({ status: 'cancelled' });

      const result = await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
        },
      );

      expect(result).toEqual([]);
      expect(fakeDryRunService.diff).not.toHaveBeenCalled();
      // The only job.update call is the earlier 'running' transition --
      // status must never be forced back to 'failed' for a cancellation.
      expect(fakePrisma.job.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'failed' } }));
      expect(fakeJobEventsPublisher.publish).toHaveBeenCalledWith('job-1', 'cancelled');
      expect(fakePrisma.auditEntry.create).toHaveBeenCalledWith({
        data: { jobId: 'job-1', message: 'Pipeline stopped: job was cancelled' },
      });
    });

    it('never overwrites status to running when the job was already cancelled the instant the worker picked it up', async () => {
      fakePrisma.job.findUnique.mockResolvedValue({ status: 'cancelled' });

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
        },
      );

      expect(fakePrisma.job.update).not.toHaveBeenCalled();
      expect(fakeIngestionClient.ingest).not.toHaveBeenCalled();
      expect(fakeJobEventsPublisher.publish).toHaveBeenCalledWith('job-1', 'cancelled');
    });
  });

  describe('area-path backfill', () => {
    beforeEach(() => {
      // The cancellation describe block above persistently overrides
      // job.findUnique to {status: 'cancelled'} on its last test, and
      // clearAllMocks does NOT reset a mock's implementation -- restore
      // the "not cancelled" default so assertNotCancelled's checkpoint at
      // the very top of runPipelineJob doesn't short-circuit every test
      // in THIS block before it ever reaches ingest/backfill.
      fakePrisma.job.findUnique.mockResolvedValue({ status: 'running' });
      fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
      fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
      fakeDryRunService.diff.mockResolvedValue([]);
    });

    it("closes the manually-created-ADO-item gap by backfilling a fresh area path (no AreaPathBackfill row yet)", async () => {
      fakePrisma.areaPathBackfill.findUnique.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: 'user-1', customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
        },
      );

      expect(fakeBackfillService.backfillAreaPath).toHaveBeenCalledWith('Project\\Area1', undefined);
      expect(fakePrisma.areaPathBackfill.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { areaPath: 'Project\\Area1' } }),
      );
    });

    it('does not re-scan an area path backfilled less than 24h ago', async () => {
      fakePrisma.areaPathBackfill.findUnique.mockResolvedValue({
        areaPath: 'Project\\Area1',
        lastBackfilledAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
      });

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: 'user-1', customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
        },
      );

      expect(fakeBackfillService.backfillAreaPath).not.toHaveBeenCalled();
      expect(fakePrisma.areaPathBackfill.upsert).not.toHaveBeenCalled();
    });

    it('re-scans an area path backfilled more than 24h ago', async () => {
      fakePrisma.areaPathBackfill.findUnique.mockResolvedValue({
        areaPath: 'Project\\Area1',
        lastBackfilledAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
      });

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: 'user-1', customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
        },
      );

      expect(fakeBackfillService.backfillAreaPath).toHaveBeenCalledWith('Project\\Area1', undefined);
    });

    it("never fails the job when the backfill call throws -- fail-open, same philosophy as every other optional enrichment", async () => {
      fakePrisma.areaPathBackfill.findUnique.mockResolvedValue(null);
      fakeBackfillService.backfillAreaPath.mockRejectedValueOnce(new Error('ADO unreachable'));

      const result = await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: 'user-1', customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
        },
      );

      expect(result).toEqual([]);
      expect(fakePrisma.job.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'diff_ready' }) }),
      );
      expect(fakePrisma.areaPathBackfill.upsert).not.toHaveBeenCalled();
    });
  });

  describe('whole-document primer (Phase 6c)', () => {
    // No document-size gate any more (Task 4) -- bigDoc/bigFileBuffer are
    // kept only as a realistic fixture for tests that don't care about
    // size, and because the upload call and the cache key are still keyed
    // on the real file.
    const bigDoc = { blocks: [{ id: 'b0', text: 'a'.repeat(30_000) }] };
    const bigFileBuffer = Buffer.alloc(30_000, 'a');

    beforeEach(() => {
      fakeIngestionClient.ingest.mockResolvedValue(bigDoc);
      fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
      fakeDryRunService.diff.mockResolvedValue([]);
    });

    it('threads primerContext from a successful upload+chat into the level() call', async () => {
      fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
      fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
      fakeOpenWebUiClient.chatWithFullFileContext.mockResolvedValue({ content: 'This is an avionics ICD.' });
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: bigFileBuffer, filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(fakeIngestionClient.level).toHaveBeenCalledWith(
        bigDoc, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', 'This is an avionics ICD.',
      );
      expect(fakeOpenWebUiClient.uploadFile).toHaveBeenCalledWith(bigFileBuffer, 'x.pdf');
      // chatWithFullFileContext, NOT chat() -- chat() goes through the
      // OpenAI SDK, which can never reach Open WebUI's native file-context
      // endpoint (see chatWithFullFileContext's own doc comment,
      // openwebui.client.ts). temperature/seed determinism pinning now
      // lives INSIDE that method (hardcoded, not passed as opts) since it
      // has exactly one caller with exactly one determinism requirement.
      expect(fakeOpenWebUiClient.chatWithFullFileContext).toHaveBeenCalledWith(
        expect.any(String),
        'file-1',
        expect.objectContaining({ maxTokens: 300 }),
      );
      expect(fakeOpenWebUiClient.deleteFile).toHaveBeenCalledWith('file-1');
      expect(fakePrimerCacheRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('primer:gemma4:12b:'), 'This is an avionics ICD.', 'EX', 86_400,
      );
    });

    it('fails open to undefined primerContext when upload throws', async () => {
      fakeOpenWebUiClient.uploadFile.mockRejectedValue(new Error('network error'));
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: bigFileBuffer, filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(fakeIngestionClient.level).toHaveBeenCalledWith(
        bigDoc, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', undefined,
      );
    });

    it('reads from the primer cache instead of re-uploading on a cache hit', async () => {
      fakePrimerCacheRedis.get.mockResolvedValue('cached primer text');

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: bigFileBuffer, filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(fakeOpenWebUiClient.uploadFile).not.toHaveBeenCalled();
      expect(fakeIngestionClient.level).toHaveBeenCalledWith(
        bigDoc, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', 'cached primer text',
      );
    });

    it('never attempts the primer for a BASELINE job, even with primer deps wired and a large document -- BASELINE never calls an LLM', async () => {
      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: bigFileBuffer, filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(fakePrimerCacheRedis.get).not.toHaveBeenCalled();
      expect(fakeOpenWebUiClient.uploadFile).not.toHaveBeenCalled();
      expect(fakeIngestionClient.level).toHaveBeenCalledWith(
        bigDoc, null, 'baseline', undefined, [], 'gemma4:12b', 'job-1', undefined,
      );
    });

    it('clamps an overly long chat reply to PRIMER_CONTEXT_MAX_CHARS before threading it into level() -- a verbose reply must never blow past /level\'s own query-string size limit', async () => {
      // Regression guard: primerContext is threaded into /level as a URL
      // query param (ingestion-http.client.ts) -- an unclamped reply here
      // risks exceeding uvicorn/h11's request-line size limit, throwing a
      // 400/431 from the /level call itself (OUTSIDE this primer block's
      // own try/catch), failing the whole job over exactly the kind of soft
      // LLM misbehavior (ignoring "2-3 short sentences") the primer's
      // fail-open design exists to absorb.
      const overlyLongReply = 'x'.repeat(5000);
      fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
      fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
      fakeOpenWebUiClient.chatWithFullFileContext.mockResolvedValue({ content: overlyLongReply });
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: bigFileBuffer, filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      const clampedPrimerContext = fakeIngestionClient.level.mock.calls[0][7];
      expect(clampedPrimerContext).toHaveLength(1000);
      expect(clampedPrimerContext).toBe(overlyLongReply.slice(0, 1000));
      expect(fakePrimerCacheRedis.set).toHaveBeenCalledWith(expect.any(String), clampedPrimerContext, 'EX', 86_400);
    });

    it('passes maxTokens on the primer chat call -- bounds worst-case latency/output, same precedent as vision()\'s own caption cap', async () => {
      fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
      fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
      fakeOpenWebUiClient.chatWithFullFileContext.mockResolvedValue({ content: 'A short primer.' });
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: bigFileBuffer, filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(fakeOpenWebUiClient.chatWithFullFileContext).toHaveBeenCalledWith(
        expect.any(String),
        'file-1',
        expect.objectContaining({ maxTokens: 300 }),
      );
    });

    it('logs the primer failure (with the job id) instead of swallowing it silently', async () => {
      // Whole-branch review Finding 6: this repo's own k8s default points
      // LLM_BASE_URL at raw Ollama, which has no /api/v1/files/ endpoint at
      // all -- so in that documented default deployment the primer fails on
      // EVERY job, forever. Failing open is correct; failing open silently
      // is not.
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      fakeOpenWebUiClient.uploadFile.mockRejectedValue(new Error('404 Not Found: /api/v1/files/'));
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      try {
        await runPipelineJob(
          { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: bigFileBuffer, filename: 'x.pdf' },
          {
            ingestionClient: fakeIngestionClient as any,
            dryRunService: fakeDryRunService as any,
            idempotencyService: fakeIdempotencyService as any,
            prisma: fakePrisma as any,
            jobEventsPublisher: fakeJobEventsPublisher as any,
            mcpClient: fakeMcpClient as any,
            backfillService: fakeBackfillService as any,
            adoCredentialResolver: fakeAdoCredentialResolver as any,
            defaultLlmModel: 'gemma4:12b',
            openWebUiClient: fakeOpenWebUiClient as any,
            primerCacheRedis: fakePrimerCacheRedis as any,
          },
        );

        // Asserted BEFORE mockRestore() below -- mockRestore also resets the
        // spy's recorded calls, so asserting after it always sees zero.
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('job-1'),
          expect.objectContaining({ message: expect.stringContaining('/api/v1/files/') }),
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }

      // Still fails open -- the job itself is unaffected.
      expect(fakeIngestionClient.level).toHaveBeenCalledWith(
        bigDoc, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', undefined,
      );
    });

    it('attempts the primer unconditionally for a SURVEY job -- no document-size gate anymore', async () => {
      // A TINY doc -- the old gate would have skipped the primer for this
      // (well under PRIMER_CONTEXT_MIN_DOCUMENT_TEXT_CHARS). Deliberately NOT
      // using this block's own bigDoc/bigFileBuffer fixtures -- the whole
      // point of this test is that document/file size no longer matters at
      // all.
      fakeIngestionClient.ingest.mockResolvedValue({ blocks: [{ id: 'b0', text: 'x' }] });
      fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
      fakeDryRunService.diff.mockResolvedValue([]);
      fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
      fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
      fakeOpenWebUiClient.chatWithFullFileContext.mockResolvedValue({ content: 'This is an avionics ICD.' });
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(fakeOpenWebUiClient.uploadFile).toHaveBeenCalled();
      expect(fakeIngestionClient.level).toHaveBeenCalledWith(
        { blocks: [{ id: 'b0', text: 'x' }] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-1', 'This is an avionics ICD.',
      );
    });

    it('computes the primer BEFORE calling ingestionClient.ingest -- figures need it during parsing', async () => {
      fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
      fakeDryRunService.diff.mockResolvedValue([]);
      fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
      fakeOpenWebUiClient.chatWithFullFileContext.mockResolvedValue({ content: 'Primer text.' });
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      const callOrder: string[] = [];
      fakeOpenWebUiClient.uploadFile.mockImplementation(async () => {
        callOrder.push('primer-upload');
        return 'file-1';
      });
      fakeIngestionClient.ingest.mockImplementation(async () => {
        callOrder.push('ingest');
        return { blocks: [] };
      });

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(callOrder).toEqual(['primer-upload', 'ingest']);
    });

    it('passes the SAME primerContext value to both ingestionClient.ingest and ingestionClient.level -- computed once, not twice', async () => {
      fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
      fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
      fakeDryRunService.diff.mockResolvedValue([]);
      fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
      fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
      fakeOpenWebUiClient.chatWithFullFileContext.mockResolvedValue({ content: 'Primer text.' });
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      const ingestPrimerArg = fakeIngestionClient.ingest.mock.calls[0][5];
      const levelPrimerArg = fakeIngestionClient.level.mock.calls[0][7];
      expect(ingestPrimerArg).toBe('Primer text.');
      expect(levelPrimerArg).toBe('Primer text.');
    });

    it('passes a fixed, generous numCtx on the primer chat call -- no per-document sizing is possible before /ingest has run', async () => {
      fakeIngestionClient.ingest.mockResolvedValue({ blocks: [] });
      fakeIngestionClient.level.mockResolvedValue({ nodes: [] });
      fakeDryRunService.diff.mockResolvedValue([]);
      fakeOpenWebUiClient.uploadFile.mockResolvedValue('file-1');
      fakeOpenWebUiClient.pollFileProcessed.mockResolvedValue(true);
      fakeOpenWebUiClient.chatWithFullFileContext.mockResolvedValue({ content: 'Primer text.' });
      fakePrimerCacheRedis.get.mockResolvedValue(null);

      await runPipelineJob(
        { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'survey', fileBuffer: Buffer.from('x'), filename: 'x.pdf' },
        {
          ingestionClient: fakeIngestionClient as any,
          dryRunService: fakeDryRunService as any,
          idempotencyService: fakeIdempotencyService as any,
          prisma: fakePrisma as any,
          jobEventsPublisher: fakeJobEventsPublisher as any,
          mcpClient: fakeMcpClient as any,
          backfillService: fakeBackfillService as any,
          adoCredentialResolver: fakeAdoCredentialResolver as any,
          defaultLlmModel: 'gemma4:12b',
          openWebUiClient: fakeOpenWebUiClient as any,
          primerCacheRedis: fakePrimerCacheRedis as any,
        },
      );

      expect(fakeOpenWebUiClient.chatWithFullFileContext.mock.calls[0][2]).toEqual(expect.objectContaining({ numCtx: 32_768 }));
    });
  });
});
