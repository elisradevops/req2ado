import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { JobsController } from '../src/modules/pipeline/jobs.controller';

const TEST_USER = { userId: 'user-1', displayName: 'User One' } as any;
const MAP = [{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }];
const file = (over: Partial<Express.Multer.File> = {}) =>
  ({ buffer: Buffer.from('doc'), originalname: 'spec.docx', size: 3, ...over }) as Express.Multer.File;

// The wizard sends the document itself (not only its heading map): the overview is a study of the document, run by ingestion.
describe('JobsController.previewExposition', () => {
  function makeController(documentOverviewService: any, maxUploadSizeBytes = 1024 * 1024): JobsController {
    return new JobsController(
      {} as any, // jobsService
      {} as any, // ingestionClient
      { isModelHidden: () => false } as any, // clientFactory
      {} as any, // adoCredentialResolver
      {} as any, // workItemTypeCatalogService
      {} as any, // etaService
      maxUploadSizeBytes,
      documentOverviewService,
    );
  }

  it('studies the uploaded document for the caller and returns the overview', async () => {
    const documentOverviewService = { generate: jest.fn().mockResolvedValue({ synopsis: 'Defines 2 terms.', caveat: null }) };
    const f = file();

    const result = await makeController(documentOverviewService).previewExposition(TEST_USER, f, JSON.stringify(MAP), '1', '2', 'gemma4:12b');

    expect(result).toEqual({ synopsis: 'Defines 2 terms.', caveat: null });
    expect(documentOverviewService.generate).toHaveBeenCalledWith(
      { file: f, documentMap: MAP, sectionCount: 1, depth: 2, model: 'gemma4:12b' },
      'user-1',
    );
  });

  it('works without a chosen model', async () => {
    const documentOverviewService = { generate: jest.fn().mockResolvedValue(null) };
    await makeController(documentOverviewService).previewExposition(TEST_USER, file(), JSON.stringify(MAP), '1', '2', undefined);
    expect(documentOverviewService.generate.mock.calls[0][0].model).toBeUndefined();
  });

  it.each([
    ['a missing documentMap', undefined, '1', '2'],
    ['a documentMap that is not JSON', '{nope', '1', '2'],
    ['a documentMap that is not an array', '{"a":1}', '1', '2'],
    ['a sectionCount that is not a number', JSON.stringify(MAP), 'x', '2'],
    ['a missing depth', JSON.stringify(MAP), '1', undefined],
  ])('returns null without studying anything for %s', async (_label, map, sections, depth) => {
    const documentOverviewService = { generate: jest.fn() };
    const result = await makeController(documentOverviewService).previewExposition(TEST_USER, file(), map as any, sections as any, depth as any, undefined);
    expect(result).toBeNull();
    expect(documentOverviewService.generate).not.toHaveBeenCalled();
  });

  it('rejects a request with no file', async () => {
    const documentOverviewService = { generate: jest.fn() };
    await expect(
      makeController(documentOverviewService).previewExposition(TEST_USER, undefined, JSON.stringify(MAP), '1', '2', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies the same size and type limits as the preview', async () => {
    const documentOverviewService = { generate: jest.fn() };
    const controller = makeController(documentOverviewService, 10);
    await expect(controller.previewExposition(TEST_USER, file({ size: 11 }), JSON.stringify(MAP), '1', '2', undefined)).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(
      makeController(documentOverviewService).previewExposition(TEST_USER, file({ originalname: 'x.exe' }), JSON.stringify(MAP), '1', '2', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(documentOverviewService.generate).not.toHaveBeenCalled();
  });
});

// The wizard's route: the same study, answered as a stream of lines (progress and heartbeat while it works, then one result or error line) so a
// long document does not look stuck.
describe('JobsController.previewExpositionStream', () => {
  function makeController(documentOverviewService: any): JobsController {
    return new JobsController({} as any, {} as any, { isModelHidden: () => false } as any, {} as any, {} as any, {} as any, 1024 * 1024, documentOverviewService);
  }
  function makeRes() {
    const handlers: Record<string, () => void> = {};
    const written: string[] = [];
    return {
      setHeader: jest.fn(), flushHeaders: jest.fn(), status: jest.fn(), end: jest.fn(),
      write: jest.fn((chunk: string) => { written.push(chunk); return true; }),
      on: jest.fn((event: string, handler: () => void) => { handlers[event] = handler; }),
      written, handlers,
      lines: () => written.map((w) => JSON.parse(w)),
    };
  }
  const call = (controller: JobsController, res: any, f: Express.Multer.File | undefined = file(), map = JSON.stringify(MAP)) =>
    controller.previewExpositionStream(TEST_USER, res, f, map, '1', '2', undefined);

  it('streams progress and heartbeats as lines, then the overview as one result line', async () => {
    const generate = jest.fn(async (input: any) => {
      input.onProgress({ done: 0, total: 2, elapsed: 0 });
      input.onProgress({ elapsed: 5 });
      input.onProgress({ done: 2, total: 2, elapsed: 9 });
      return { synopsis: 'Defines 2 terms.', caveat: null };
    });
    const res = makeRes();

    await call(makeController({ generate }), res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(res.lines()).toEqual([
      { type: 'progress', done: 0, total: 2, elapsed: 0 },
      { type: 'heartbeat', elapsed: 5 },
      { type: 'progress', done: 2, total: 2, elapsed: 9 },
      { type: 'result', overview: { synopsis: 'Defines 2 terms.', caveat: null } },
    ]);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('streams a null overview as a result line (no overview is a normal answer)', async () => {
    const res = makeRes();
    await call(makeController({ generate: jest.fn().mockResolvedValue(null) }), res);
    expect(res.lines()).toEqual([{ type: 'result', overview: null }]);
  });

  it('ends with one error line, carrying only the error type, when the study fails', async () => {
    const res = makeRes();
    await call(makeController({ generate: jest.fn().mockRejectedValue(new TypeError('connect ECONNREFUSED http://secret-host')) }), res);
    expect(res.lines()).toEqual([{ type: 'error', detail: 'The study of the document failed (TypeError).' }]);
    expect(res.written.join('')).not.toContain('secret-host');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('aborts the study when the browser disconnects', async () => {
    let received: AbortSignal | undefined;
    const generate = jest.fn((input: any) => new Promise((resolve) => {
      received = input.signal;
      setImmediate(() => resolve(null));
    }));
    const res = makeRes();
    const pending = call(makeController({ generate }), res);
    await new Promise((r) => setImmediate(r));
    res.handlers.close?.();
    await pending;
    expect(received?.aborted).toBe(true);
  });

  it('applies the same validation as the plain route before any line is written', async () => {
    const res = makeRes();
    await expect(call(makeController({ generate: jest.fn() }), res, null as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(res.write).not.toHaveBeenCalled();
    await expect(call(makeController({ generate: jest.fn() }), res, file({ originalname: 'x.exe' }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers an unusable heading map with a null result line', async () => {
    const generate = jest.fn();
    const res = makeRes();
    await call(makeController({ generate }), res, file(), '{nope');
    expect(res.lines()).toEqual([{ type: 'result', overview: null }]);
    expect(generate).not.toHaveBeenCalled();
  });
});
