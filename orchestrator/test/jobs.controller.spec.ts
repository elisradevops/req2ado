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
          { kind: 'heading' },
          { kind: 'paragraph' },
          { kind: 'heading' },
          { kind: 'paragraph' },
          { kind: 'paragraph' },
        ],
      }),
    };
    const jobsService = { submit: jest.fn() };
    const controller = new JobsController(jobsService as any, 500 * 1024 * 1024, ingestionClient as any);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 4 } as Express.Multer.File;
    const result = await controller.preview(file);

    expect(ingestionClient.ingest).toHaveBeenCalledWith(file.buffer, 'req.docx');
    expect(result).toEqual({ blockCount: 5, sectionCount: 2, fileType: 'docx' });
  });

  it('throws BadRequestException when no file is provided', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const controller = new JobsController(jobsService as any, 500 * 1024 * 1024, ingestionClient as any);

    await expect(controller.preview(undefined)).rejects.toThrow('file is required');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });

  it('throws PayloadTooLargeException when file exceeds maxUploadSizeBytes', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const maxUploadSize = 10 * 1024 * 1024; // 10MB
    const controller = new JobsController(jobsService as any, maxUploadSize, ingestionClient as any);

    const file = { buffer: Buffer.from('x'), originalname: 'req.docx', size: 20 * 1024 * 1024 } as Express.Multer.File;

    await expect(controller.preview(file)).rejects.toThrow('file exceeds the 10MB upload limit');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when file has unsupported extension', async () => {
    const jobsService = { submit: jest.fn() };
    const ingestionClient = { ingest: jest.fn() };
    const controller = new JobsController(jobsService as any, 500 * 1024 * 1024, ingestionClient as any);

    const file = { buffer: Buffer.from('x'), originalname: 'req.exe', size: 4 } as Express.Multer.File;

    await expect(controller.preview(file)).rejects.toThrow('unsupported file type: .exe');
    expect(ingestionClient.ingest).not.toHaveBeenCalled();
  });
});
