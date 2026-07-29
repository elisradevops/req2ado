import { runPipelineJob } from '../src/modules/pipeline/pipeline.worker';

describe('runPipelineJob', () => {
  const fakeIngestionClient = { ingest: jest.fn(), level: jest.fn(), checkDuplicate: jest.fn() };
  const fakeDryRunService = { diff: jest.fn() };
  const fakeIdempotencyService = { lookup: jest.fn(), record: jest.fn() };
  const fakePrisma = {
    // findUnique backs assertNotCancelled's cooperative-cancellation
    // checkpoints -- defaults to 'running' (never cancelled) so every
    // existing test's happy/failure path is unaffected; the dedicated
    // cancellation describe block below overrides this per-test.
    job: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ status: 'running' }) },
    auditEntry: { create: jest.fn() },
    dedupSkipAudit: { createMany: jest.fn() },
  };
  const fakeJobEventsPublisher = { publish: jest.fn() };
  const fakeMcpClient = {
    discoverLinkTypes: jest.fn().mockResolvedValue([]),
    discoverFields: jest.fn().mockResolvedValue([]),
    queryIds: jest.fn().mockResolvedValue([]),
  };
  const fakeAdoCredentialResolver = { resolve: jest.fn().mockResolvedValue(undefined) };

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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.ingest).toHaveBeenCalledWith(Buffer.from('text'), 'x.txt', false, 'baseline', 'job-1');
    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [{ id: 'b0' }] }, 'CUST-1', 'baseline', undefined, [], 'gemma4:12b', 'job-1');
    expect(result).toEqual([{ localId: 'n0', action: 'create', existingAdoId: null }]);
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-1');
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { status: 'diff_ready', dryRunDiff: [], warnings: [], kbCitations: [] },
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.job.update).toHaveBeenNthCalledWith(1, { where: { id: 'job-1' }, data: { status: 'running' } });
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        {
          localId: 'n0', sourceHash: 'hashA', legacySourceHash: 'hashA', customerId: 'CUST-1', areaPath: 'Project\\Area1',
          groundingScore: null, sourceRef: null, tags: [], traceLinks: [],
        },
        {
          localId: 'n1', sourceHash: 'hashB', legacySourceHash: 'hashB', customerId: 'CUST-1', areaPath: 'Project\\Area1',
          groundingScore: null, sourceRef: null, tags: [], traceLinks: [],
        },
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
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: 'CUST-1', mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt', followUp: true },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
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
        },
      ],
      fakeIdempotencyService,
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
          childType: 'Requirement', traceLinks: [],
        },
        {
          localId: 'n1', sourceHash: 'hashB', legacySourceHash: 'hashB', customerId: 'CUST-1', areaPath: 'Project\\Area1',
          groundingScore: null, sourceRef: null, tags: [],
          qualityScore: undefined, qualityIssues: undefined, qualityCategoryScores: undefined,
          childType: undefined, traceLinks: [],
        },
      ],
      fakeIdempotencyService,
      expect.any(Function),
    );
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
      warnings: ['SURVEY node count (1) diverges from source block count (5) by more than 50%'],
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeDryRunService.diff).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          localId: 'n0',
          sourceRef: { documentPath: '/tmp/doc.docx', startOffset: 10, endOffset: 20, page: null },
          tags: ['functional', 'safety'],
        }),
      ],
      fakeIdempotencyService,
      expect.any(Function),
    );
    expect(fakePrisma.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'diff_ready',
        dryRunDiff: [],
        warnings: ['SURVEY node count (1) diverges from source block count (5) by more than 50%'],
        kbCitations: [],
      },
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    const dedupCheckArg = fakeDryRunService.diff.mock.calls[0][2];
    await dedupCheckArg('Desc 0', 'Project\\Area1');
    expect(fakeIngestionClient.checkDuplicate).toHaveBeenCalledWith('Desc 0', 'Project\\Area1');
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    const dedupCheckArg = fakeDryRunService.diff.mock.calls[0][2];
    expect(dedupCheckArg).toBeDefined();
    await dedupCheckArg('Desc 0', 'Project\\Area1');
    expect(fakeIngestionClient.checkDuplicate).toHaveBeenCalledWith('Desc 0', 'Project\\Area1');
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeJobEventsPublisher.publish.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      'parse',
      'infer_hierarchy_start',
      'generate_requirements_done',
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', 'user-descriptor-1', [], 'gemma4:12b', 'job-1');
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-1');
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'qwen2.5:1.5b', 'job-1');
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakeIngestionClient.level).toHaveBeenCalledWith({ blocks: [] }, null, 'survey', undefined, [], 'gemma4:12b', 'job-xyz');
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
      },
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

    await runPipelineJob(
      { id: 'job-1', areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline', fileBuffer: Buffer.from(''), filename: 'x.txt' },
      {
        ingestionClient: fakeIngestionClient as any,
        dryRunService: fakeDryRunService as any,
        idempotencyService: fakeIdempotencyService as any,
        prisma: fakePrisma as any,
        jobEventsPublisher: fakeJobEventsPublisher as any,
        mcpClient: fakeMcpClient as any,
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
        adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
      },
    );

    expect(fakePrisma.dedupSkipAudit.createMany).not.toHaveBeenCalled();
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
          adoCredentialResolver: fakeAdoCredentialResolver as any,
        defaultLlmModel: 'gemma4:12b',
        },
      );

      expect(fakePrisma.job.update).not.toHaveBeenCalled();
      expect(fakeIngestionClient.ingest).not.toHaveBeenCalled();
      expect(fakeJobEventsPublisher.publish).toHaveBeenCalledWith('job-1', 'cancelled');
    });
  });
});
