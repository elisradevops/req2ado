import { JobsController } from '../src/modules/pipeline/jobs.controller';

// CanonicalDoc (ingestion/app/canonical/model.py) has no top-level `sections`
// field — only `document`, `blocks`, `tables`, `figures`. Each Block carries
// a `kind` (BlockKind str-enum, e.g. "heading", "paragraph", ...). Section
// count is therefore derived as the number of blocks whose kind is
// "heading", not a separate sections array.
describe('JobsController.preview', () => {
  it('returns block/section counts and file type from the ingestion client response', async () => {
    const ingestionClient = {
      ingest: jest.fn().mockResolvedValue({
        blocks: [
          { kind: 'heading', heading_level: 1 },
          { kind: 'paragraph' },
          { kind: 'heading', heading_level: 2 },
          { kind: 'paragraph' },
          { kind: 'paragraph' },
        ],
        figures: [{ id: 'fig-1' }, { id: 'fig-2' }],
      }),
    };
    const jobsService = { submit: jest.fn() };
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 4 } as Express.Multer.File;
    const result = await controller.preview(file);

    // skipVision=true: preview only needs blockCount/sectionCount/fileType,
    // never figure captions -- must not pay the per-image vision-LLM cost
    // (confirmed live: 28s instead of ~30ms for one small embedded image).
    expect(ingestionClient.ingest).toHaveBeenCalledWith(file.buffer, 'req.docx', true);
    expect(result).toEqual({ blockCount: 5, sectionCount: 2, figureCount: 2, depth: 2, fileType: 'docx' });
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
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 4 } as Express.Multer.File;
    const result = await controller.preview(file);

    expect(result).toEqual({ blockCount: 1, sectionCount: 0, figureCount: 0, depth: 0, fileType: 'docx' });
  });

  it('throws BadRequestException when no file is provided', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    await expect(controller.preview(undefined)).rejects.toThrow('file is required');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });

  it('throws PayloadTooLargeException when file exceeds maxUploadSizeBytes', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const maxUploadSize = 10 * 1024 * 1024; // 10MB
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, maxUploadSize);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 20 * 1024 * 1024 } as Express.Multer.File;

    await expect(controller.preview(file)).rejects.toThrow('file exceeds the 10MB upload limit');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when file has unsupported extension', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const controller = new JobsController(jobsService as any, ingestionClient as any, {} as any, {} as any, {} as any, 500 * 1024 * 1024);

    const file = { buffer: Buffer.from('x'), originalname: 'req.exe', size: 4 } as Express.Multer.File;

    await expect(controller.preview(file)).rejects.toThrow('unsupported file type: .exe');
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
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, 500 * 1024 * 1024,
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
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, 500 * 1024 * 1024,
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
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, 500 * 1024 * 1024,
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
      jobsService as any, {} as any, {} as any, adoCredentialResolver as any, workItemTypeCatalogService as any, 500 * 1024 * 1024,
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
    const controller = new JobsController(jobsService as any, ingestionClient as any, llmClient as any, {} as any, {} as any, 500 * 1024 * 1024);

    const result = await controller.listModels();

    expect(result).toEqual({ models: ['qwen2.5:1.5b', 'gemma4:e4b'] });
  });
});
