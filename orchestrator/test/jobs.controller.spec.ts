import { JobsController } from '../src/modules/pipeline/jobs.controller';

// CanonicalDoc (ingestion/app/canonical/model.py) has no top-level `sections`
// field — only `document`, `blocks`, `tables`, `figures`. Each Block carries
// a `kind` (BlockKind str-enum, e.g. "heading", "paragraph", ...). Section
// count is therefore derived as the number of blocks whose kind is
// "heading", not a separate sections array.
describe('JobsController.preview', () => {
  it('returns block/section counts, file type, and the document map from the ingestion client response', async () => {
    const ingestionClient = {
      ingest: jest.fn().mockResolvedValue({
        blocks: [
          { kind: 'heading', heading_level: 1, number_label: '1', text: 'Introduction' },
          { kind: 'paragraph' },
          { kind: 'heading', heading_level: 2, number_label: '1.1', text: 'Scope' },
          { kind: 'paragraph' },
          { kind: 'figure' },
        ],
        figures: [{ id: 'fig-1' }, { id: 'fig-2' }],
        tables: [{ id: 'tbl-1' }],
      }),
    };
    const jobsService = { submit: jest.fn() };
    const etaService = { estimate: jest.fn().mockResolvedValue({ mode: 'baseline', estimateMinutes: 1 }) };
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, etaService as any, 500 * 1024 * 1024);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 4 } as Express.Multer.File;
    const result = await controller.preview(file, undefined, undefined);

    // skipVision=true: preview only needs blockCount/sectionCount/fileType,
    // never figure captions -- must not pay the per-image vision-LLM cost
    // (confirmed live: 28s instead of ~30ms for one small embedded image).
    expect(ingestionClient.ingest).toHaveBeenCalledWith(file.buffer, 'req.docx', true);
    // DESIGN.md §11.2.3.d -- estimate() is called with the real parsed
    // counts and defaults mode to 'baseline' when the caller (here, and
    // NewJobWizard.tsx before the user picks anything) hasn't specified one.
    expect(etaService.estimate).toHaveBeenCalledWith({ mode: 'baseline', blockCount: 5, figureCount: 2, model: undefined });
    expect(result).toEqual({
      blockCount: 5,
      sectionCount: 2,
      figureCount: 2,
      depth: 2,
      fileType: 'docx',
      estimate: { mode: 'baseline', estimateMinutes: 1 },
      tableCount: 1,
      openTbdCount: 0,
      // Each section's heading block itself counts toward that section's
      // own blockCount (it's a real content block, not just a divider) --
      // "1" = its own heading + 1 paragraph = 2; "1.1" = its own heading + 1
      // paragraph + 1 figure block = 3.
      documentMap: [
        { number: '1', title: 'Introduction', blockCount: 2, figureCount: 0 },
        { number: '1.1', title: 'Scope', blockCount: 3, figureCount: 1 },
      ],
    });
  });

  it('returns figureCount 0 and depth 0 when the document has no figures or headings', async () => {
    const ingestionClient = {
      // figures/tables always present on a real CanonicalDoc (Field(default_factory=list)
      // on the pydantic side) -- this fixture previously omitted figures entirely,
      // which JobsController.preview's simplified (no longer defensive) field
      // access no longer tolerates, matching the real, always-populated contract.
      ingest: jest.fn().mockResolvedValue({ blocks: [{ kind: 'paragraph' }], figures: [], tables: [] }),
    };
    const jobsService = { submit: jest.fn() };
    const etaService = { estimate: jest.fn().mockResolvedValue({ mode: 'baseline', estimateMinutes: 1 }) };
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, etaService as any, 500 * 1024 * 1024);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 4 } as Express.Multer.File;
    const result = await controller.preview(file, undefined, undefined);

    expect(result).toEqual({
      blockCount: 1,
      sectionCount: 0,
      figureCount: 0,
      depth: 0,
      fileType: 'docx',
      estimate: { mode: 'baseline', estimateMinutes: 1 },
      tableCount: 0,
      openTbdCount: 0,
      documentMap: [],
    });
  });

  it('throws BadRequestException when no file is provided', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    await expect(controller.preview(undefined, undefined, undefined)).rejects.toThrow('file is required');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });

  it('throws PayloadTooLargeException when file exceeds maxUploadSizeBytes', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const maxUploadSize = 10 * 1024 * 1024; // 10MB
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, {} as any, maxUploadSize);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 20 * 1024 * 1024 } as Express.Multer.File;

    await expect(controller.preview(file, undefined, undefined)).rejects.toThrow('file exceeds the 10MB upload limit');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when file has unsupported extension', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    const file = { buffer: Buffer.from('x'), originalname: 'req.exe', size: 4 } as Express.Multer.File;

    await expect(controller.preview(file, undefined, undefined)).rejects.toThrow('unsupported file type: .exe');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });
});

describe('JobsController.getById', () => {
  const TEST_USER = { userId: 'user-descriptor-1', displayName: 'Jane Doe' } as any;
  const TEST_JOB = {
    id: 'job-1',
    userId: 'user-descriptor-1',
    status: 'diff_ready',
    mode: 'survey',
    dryRunDiff: [{ localId: 'n0', type: 'Requirement' }],
    warnings: [],
    kbCitations: [],
    createdAt: new Date('2026-01-01'),
    areaPath: 'Project\\Area1',
    originalFilename: 'req.docx',
  };

  it('embeds the resolved work-item-type catalog directly in the response -- no separate frontend request needed', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue(TEST_JOB) };
    const adoCredentialResolver = { resolve: jest.fn().mockResolvedValue({ orgUrl: 'https://ado.example', pat: 'x' }) };
    const catalog = { Requirement: { color: '#009CCC', iconDataUrl: 'data:image/svg+xml;base64,AAA' } };
    const workItemTypeCatalogService = { resolve: jest.fn().mockResolvedValue(catalog) };
    const controller = new JobsController(
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, {} as any, 500 * 1024 * 1024,
    );

    const result = await controller.getById('job-1', TEST_USER);

    // Derives the team project from the job's OWN areaPath (its first
    // path segment) -- the frontend never has to send this back.
    expect(workItemTypeCatalogService.resolve).toHaveBeenCalledWith('Project', { orgUrl: 'https://ado.example', pat: 'x' });
    expect(result.workItemTypeCatalog).toEqual(catalog);
    expect((result as any).userId).toBeUndefined(); // still stripped, same as before this field existed
  });

  it('does not attempt catalog resolution when the job has no diff yet (still running)', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue({ ...TEST_JOB, dryRunDiff: null }) };
    const adoCredentialResolver = { resolve: jest.fn() };
    const workItemTypeCatalogService = { resolve: jest.fn() };
    const controller = new JobsController(
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, {} as any, 500 * 1024 * 1024,
    );

    const result = await controller.getById('job-1', TEST_USER);

    expect(adoCredentialResolver.resolve).not.toHaveBeenCalled();
    expect(workItemTypeCatalogService.resolve).not.toHaveBeenCalled();
    expect(result.workItemTypeCatalog).toEqual({});
  });

  it('falls back to an empty catalog when there is no vaulted ADO credential', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue(TEST_JOB) };
    const adoCredentialResolver = { resolve: jest.fn().mockResolvedValue(undefined) };
    const workItemTypeCatalogService = { resolve: jest.fn() };
    const controller = new JobsController(
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, {} as any, 500 * 1024 * 1024,
    );

    const result = await controller.getById('job-1', TEST_USER);

    expect(workItemTypeCatalogService.resolve).not.toHaveBeenCalled();
    expect(result.workItemTypeCatalog).toEqual({});
  });

  it('falls back to an empty catalog (never fails the job fetch) when catalog resolution throws', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue(TEST_JOB) };
    const adoCredentialResolver = { resolve: jest.fn().mockResolvedValue({ orgUrl: 'https://ado.example', pat: 'x' }) };
    const workItemTypeCatalogService = { resolve: jest.fn().mockRejectedValue(new Error('ADO unreachable')) };
    const controller = new JobsController(
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, {} as any, 500 * 1024 * 1024,
    );

    const result = await controller.getById('job-1', TEST_USER);

    expect(result.workItemTypeCatalog).toEqual({});
    expect(result.id).toBe('job-1'); // the job itself is still returned
  });
});

describe('JobsController.listModels', () => {
  it('returns the model list from the LLM client, unauthenticated (browser-reachable, unlike /llm/models)', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const llmClient = { listModels: jest.fn().mockResolvedValue(['qwen2.5:1.5b', 'gemma4:e4b']) };
    const controller = new JobsController(jobsService as any, ingestionClient as any, llmClient as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    const result = await controller.listModels();

    expect(result).toEqual({ models: ['qwen2.5:1.5b', 'gemma4:e4b'] });
  });
});

describe('JobsController.uploadFigureFile', () => {
  it('stores compressed figure bytes via jobsService.storeFigureFile', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue({ id: 'job-1' }), storeFigureFile: jest.fn().mockResolvedValue(undefined) };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    const bytes = Buffer.from('png bytes');
    const result = await controller.uploadFigureFile('job-1', 'f3', { bytes: bytes.toString('base64'), mimeType: 'image/png' });

    expect(jobsService.storeFigureFile).toHaveBeenCalledWith('job-1', 'f3', bytes, 'image/png');
    expect(result).toEqual({ stored: true });
  });

  it('404s for an unknown job -- never even parses the body', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue(null), storeFigureFile: jest.fn() };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    await expect(controller.uploadFigureFile('missing', 'f3', { bytes: 'YQ==', mimeType: 'image/png' })).rejects.toThrow('not found');
    expect(jobsService.storeFigureFile).not.toHaveBeenCalled();
  });

  it('rejects a body missing bytes/mimeType', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue({ id: 'job-1' }), storeFigureFile: jest.fn() };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    await expect(controller.uploadFigureFile('job-1', 'f3', { bytes: '' } as any)).rejects.toThrow('Invalid request body');
    expect(jobsService.storeFigureFile).not.toHaveBeenCalled();
  });

  it('rejects a figure over the 8MB per-figure cap', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue({ id: 'job-1' }), storeFigureFile: jest.fn() };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    const oversized = Buffer.alloc(9 * 1024 * 1024, 1).toString('base64');
    await expect(controller.uploadFigureFile('job-1', 'f3', { bytes: oversized, mimeType: 'image/png' })).rejects.toThrow('exceeds');
    expect(jobsService.storeFigureFile).not.toHaveBeenCalled();
  });
});

describe('JobsController.getFigureFile', () => {
  const TEST_USER = { userId: 'user-descriptor-1', displayName: 'Jane Doe' } as any;

  it('streams the figure bytes with the stored Content-Type', async () => {
    const jobsService = {
      getById: jest.fn().mockResolvedValue({ id: 'job-1', userId: 'user-descriptor-1' }),
      getFigureFile: jest.fn().mockResolvedValue({ bytes: Buffer.from('png bytes'), mimeType: 'image/png' }),
    };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);
    const res = { set: jest.fn(), send: jest.fn() };

    await controller.getFigureFile('job-1', 'f0', TEST_USER, res as any);

    expect(jobsService.getFigureFile).toHaveBeenCalledWith('job-1', 'f0');
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png bytes'));
  });

  it('404s when the figure was never stored or already attached to ADO', async () => {
    const jobsService = {
      getById: jest.fn().mockResolvedValue({ id: 'job-1', userId: 'user-descriptor-1' }),
      getFigureFile: jest.fn().mockResolvedValue(null),
    };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);
    const res = { set: jest.fn(), send: jest.fn() };

    await expect(controller.getFigureFile('job-1', 'f0', TEST_USER, res as any)).rejects.toThrow('not found');
    expect(res.send).not.toHaveBeenCalled();
  });

  it('404s for a job that does not belong to the caller -- same not-403 convention as every other per-job route', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue({ id: 'job-1', userId: 'someone-else' }), getFigureFile: jest.fn() };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);
    const res = { set: jest.fn(), send: jest.fn() };

    await expect(controller.getFigureFile('job-1', 'f0', TEST_USER, res as any)).rejects.toThrow('not found');
    expect(jobsService.getFigureFile).not.toHaveBeenCalled();
  });
});

describe('JobsController.attachFigureToAdo', () => {
  const TEST_USER = { userId: 'user-descriptor-1', displayName: 'Jane Doe' } as any;

  it('resolves an ADO credential and delegates to jobsService.attachFigureToAdo', async () => {
    const jobsService = {
      getById: jest.fn().mockResolvedValue({ id: 'job-1', userId: 'user-descriptor-1' }),
      attachFigureToAdo: jest.fn().mockResolvedValue({ attached: true, adoId: 555 }),
    };
    const adoCredentialResolver = { resolve: jest.fn().mockResolvedValue({ orgUrl: 'https://ado.example', pat: 'x' }) };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, adoCredentialResolver as any, {} as any, {} as any, 500 * 1024 * 1024);

    const result = await controller.attachFigureToAdo('job-1', 'n0', 'f0', TEST_USER);

    expect(adoCredentialResolver.resolve).toHaveBeenCalledWith('user-descriptor-1');
    expect(jobsService.attachFigureToAdo).toHaveBeenCalledWith('job-1', 'n0', 'f0', { orgUrl: 'https://ado.example', pat: 'x' });
    expect(result).toEqual({ attached: true, adoId: 555 });
  });

  it('404s for a job that does not belong to the caller before resolving any credential', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue({ id: 'job-1', userId: 'someone-else' }), attachFigureToAdo: jest.fn() };
    const adoCredentialResolver = { resolve: jest.fn() };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, adoCredentialResolver as any, {} as any, {} as any, 500 * 1024 * 1024);

    await expect(controller.attachFigureToAdo('job-1', 'n0', 'f0', TEST_USER)).rejects.toThrow('not found');
    expect(adoCredentialResolver.resolve).not.toHaveBeenCalled();
    expect(jobsService.attachFigureToAdo).not.toHaveBeenCalled();
  });
});

describe('JobsController.retryTraceLinkWrite', () => {
  const TEST_USER = { userId: 'user-descriptor-1', displayName: 'Jane Doe' } as any;

  it('resolves an ADO credential and delegates to jobsService.retryTraceLinkWrite', async () => {
    const jobsService = {
      getById: jest.fn().mockResolvedValue({ id: 'job-1', userId: 'user-descriptor-1' }),
      retryTraceLinkWrite: jest.fn().mockResolvedValue({ written: true, sourceAdoId: 101, targetAdoId: 100 }),
    };
    const adoCredentialResolver = { resolve: jest.fn().mockResolvedValue({ orgUrl: 'https://ado.example', pat: 'x' }) };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, adoCredentialResolver as any, {} as any, {} as any, 500 * 1024 * 1024);

    const result = await controller.retryTraceLinkWrite('job-1', 'failure-1', TEST_USER);

    expect(adoCredentialResolver.resolve).toHaveBeenCalledWith('user-descriptor-1');
    expect(jobsService.retryTraceLinkWrite).toHaveBeenCalledWith('job-1', 'failure-1', { orgUrl: 'https://ado.example', pat: 'x' });
    expect(result).toEqual({ written: true, sourceAdoId: 101, targetAdoId: 100 });
  });

  it('404s for a job that does not belong to the caller before resolving any credential', async () => {
    const jobsService = { getById: jest.fn().mockResolvedValue({ id: 'job-1', userId: 'someone-else' }), retryTraceLinkWrite: jest.fn() };
    const adoCredentialResolver = { resolve: jest.fn() };
    const controller = new JobsController(jobsService as any, {} as any, {} as any, adoCredentialResolver as any, {} as any, {} as any, 500 * 1024 * 1024);

    await expect(controller.retryTraceLinkWrite('job-1', 'failure-1', TEST_USER)).rejects.toThrow('not found');
    expect(adoCredentialResolver.resolve).not.toHaveBeenCalled();
    expect(jobsService.retryTraceLinkWrite).not.toHaveBeenCalled();
  });
});

// DESIGN.md §11.2.3.d -- re-pricing without re-uploading. Route ORDERING
// (declared before @Get(':id') in jobs.controller.ts) is a source-level
// concern verified by reading the decorator order, not something a unit
// test on the bare method can exercise directly (that needs a real Nest
// router, i.e. the e2e spec) -- these tests cover what a plain method call
// CAN verify: validation and the BASELINE short-circuit reaching EtaService
// correctly.
describe('JobsController.getEstimate', () => {
  it('validates the query and calls EtaService.estimate with coerced numbers', async () => {
    const etaService = { estimate: jest.fn().mockResolvedValue({ mode: 'survey', estimateMinutes: 42 }) };
    const controller = new JobsController({} as any, {} as any, {} as any, {} as any, {} as any, etaService as any, 500 * 1024 * 1024);

    const result = await controller.getEstimate({ blockCount: '682', figureCount: '39', mode: 'survey', model: 'qwen2.5:32b' });

    // Query params arrive as strings -- must be coerced to real numbers
    // before reaching the arithmetic, not passed through as-is (DESIGN.md
    // §11.2.3.d: an uncoerced string would silently produce
    // string-concatenation garbage rather than a validation error).
    expect(etaService.estimate).toHaveBeenCalledWith({ blockCount: 682, figureCount: 39, mode: 'survey', model: 'qwen2.5:32b' });
    expect(result).toEqual({ mode: 'survey', estimateMinutes: 42 });
  });

  it('rejects a missing/invalid mode with a 400, never a silent default', async () => {
    const etaService = { estimate: jest.fn() };
    const controller = new JobsController({} as any, {} as any, {} as any, {} as any, {} as any, etaService as any, 500 * 1024 * 1024);

    await expect(controller.getEstimate({ blockCount: '10', figureCount: '2', mode: 'not-a-real-mode' })).rejects.toThrow('Invalid query');
    expect(etaService.estimate).not.toHaveBeenCalled();
  });

  it('rejects a negative blockCount/figureCount', async () => {
    const etaService = { estimate: jest.fn() };
    const controller = new JobsController({} as any, {} as any, {} as any, {} as any, {} as any, etaService as any, 500 * 1024 * 1024);

    await expect(controller.getEstimate({ blockCount: '-1', figureCount: '2', mode: 'survey' })).rejects.toThrow('Invalid query');
    expect(etaService.estimate).not.toHaveBeenCalled();
  });

  it('BASELINE mode reaches EtaService, which short-circuits with no DB query of its own', async () => {
    // The short-circuit itself lives in EtaService.estimate (see
    // eta.service.spec.ts's own "no DB query" assertion) -- this test only
    // confirms the controller passes BASELINE through faithfully rather
    // than defaulting it to survey or dropping it.
    const etaService = { estimate: jest.fn().mockResolvedValue({ mode: 'baseline', estimateMinutes: 1 }) };
    const controller = new JobsController({} as any, {} as any, {} as any, {} as any, {} as any, etaService as any, 500 * 1024 * 1024);

    const result = await controller.getEstimate({ blockCount: '10', figureCount: '2', mode: 'baseline' });

    expect(etaService.estimate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline' }));
    expect(result.mode).toBe('baseline');
  });
});
