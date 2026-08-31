import { BatchController } from '../src/modules/batch/batch.controller';

const USER: any = { userId: 'user-1', displayName: 'Test User' };

function makeFile(name: string): Express.Multer.File {
  return { buffer: Buffer.from('hello world'), originalname: name, size: 11 } as Express.Multer.File;
}

describe('BatchController.submit', () => {
  it('passes files/areaPath/mode through to BatchService.submitBatch', async () => {
    const batchService = { submitBatch: jest.fn().mockResolvedValue({ batchId: 'batch-1', filesAccepted: 2, filesRejected: 0 }) };
    const controller = new BatchController(batchService as any, 25);

    const result = await controller.submit(
      [makeFile('a.txt'), makeFile('b.txt')],
      USER,
      'Project\\Area1',
      undefined,
      'survey',
      undefined,
      undefined,
      undefined,
    );

    expect(result).toEqual({ batchId: 'batch-1', filesAccepted: 2, filesRejected: 0 });
    expect(batchService.submitBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        areaPath: 'Project\\Area1',
        mode: 'survey',
        files: [
          { buffer: expect.any(Buffer), filename: 'a.txt' },
          { buffer: expect.any(Buffer), filename: 'b.txt' },
        ],
      }),
    );
  });

  it('defaults mode to baseline when not provided', async () => {
    const batchService = { submitBatch: jest.fn().mockResolvedValue({ batchId: 'batch-1', filesAccepted: 1, filesRejected: 0 }) };
    const controller = new BatchController(batchService as any, 25);

    await controller.submit([makeFile('a.txt')], USER, 'Project\\Area1', undefined, undefined, undefined, undefined, undefined);

    expect(batchService.submitBatch).toHaveBeenCalledWith(expect.objectContaining({ mode: 'baseline' }));
  });

  it('rejects an invalid mode value', async () => {
    const batchService = { submitBatch: jest.fn() };
    const controller = new BatchController(batchService as any, 25);

    await expect(
      controller.submit([makeFile('a.txt')], USER, 'Project\\Area1', undefined, 'bogus', undefined, undefined, undefined),
    ).rejects.toThrow(/mode must be/i);
    expect(batchService.submitBatch).not.toHaveBeenCalled();
  });

  it('rejects when no files are attached', async () => {
    const batchService = { submitBatch: jest.fn() };
    const controller = new BatchController(batchService as any, 25);

    await expect(controller.submit([], USER, 'Project\\Area1', undefined, undefined, undefined, undefined, undefined)).rejects.toThrow(
      /at least one file/i,
    );
    expect(batchService.submitBatch).not.toHaveBeenCalled();
  });

  it('rejects when areaPath is missing', async () => {
    const batchService = { submitBatch: jest.fn() };
    const controller = new BatchController(batchService as any, 25);

    await expect(
      controller.submit([makeFile('a.txt')], USER, undefined, undefined, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/areaPath is required/i);
  });

  it('rejects a batch exceeding the configured MAX_BATCH_FILES cap', async () => {
    const batchService = { submitBatch: jest.fn() };
    const controller = new BatchController(batchService as any, 2);

    await expect(
      controller.submit(
        [makeFile('a.txt'), makeFile('b.txt'), makeFile('c.txt')],
        USER,
        'Project\\Area1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/exceeds the 2-file limit/i);
    expect(batchService.submitBatch).not.toHaveBeenCalled();
  });
});

describe('BatchController.getBatch / list / cancelQueued -- ownership', () => {
  it('getBatch returns 404 (not 403) for a batch belonging to a different user', async () => {
    const batchService = { getBatch: jest.fn().mockResolvedValue({ id: 'batch-1', userId: 'someone-else' }) };
    const controller = new BatchController(batchService as any, 25);

    await expect(controller.getBatch('batch-1', USER)).rejects.toMatchObject({ status: 404 });
  });

  it('getBatch returns 404 for an unknown batch id', async () => {
    const batchService = { getBatch: jest.fn().mockResolvedValue(null) };
    const controller = new BatchController(batchService as any, 25);

    await expect(controller.getBatch('missing', USER)).rejects.toMatchObject({ status: 404 });
  });

  it('getBatch strips userId from the response body for an owned batch', async () => {
    const batchService = { getBatch: jest.fn().mockResolvedValue({ id: 'batch-1', userId: 'user-1', files: [] }) };
    const controller = new BatchController(batchService as any, 25);

    const result = await controller.getBatch('batch-1', USER);

    expect(result).toEqual({ id: 'batch-1', files: [] });
    expect(result).not.toHaveProperty('userId');
  });

  it('list scopes to the session userId', async () => {
    const batchService = { listBatches: jest.fn().mockResolvedValue([]) };
    const controller = new BatchController(batchService as any, 25);

    await controller.list(USER);

    expect(batchService.listBatches).toHaveBeenCalledWith('user-1');
  });

  it('cancelQueued returns 404 for a batch belonging to a different user, without cancelling anything', async () => {
    const batchService = {
      getBatch: jest.fn().mockResolvedValue({ id: 'batch-1', userId: 'someone-else' }),
      cancelQueued: jest.fn(),
    };
    const controller = new BatchController(batchService as any, 25);

    await expect(controller.cancelQueued('batch-1', USER)).rejects.toMatchObject({ status: 404 });
    expect(batchService.cancelQueued).not.toHaveBeenCalled();
  });

  it('cancelQueued delegates to BatchService for an owned batch', async () => {
    const batchService = {
      getBatch: jest.fn().mockResolvedValue({ id: 'batch-1', userId: 'user-1' }),
      cancelQueued: jest.fn().mockResolvedValue({ cancelled: 2 }),
    };
    const controller = new BatchController(batchService as any, 25);

    const result = await controller.cancelQueued('batch-1', USER);

    expect(result).toEqual({ cancelled: 2 });
    expect(batchService.cancelQueued).toHaveBeenCalledWith('batch-1');
  });
});
