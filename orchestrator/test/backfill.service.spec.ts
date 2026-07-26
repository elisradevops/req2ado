import { createHash } from 'crypto';
import { BackfillService } from '../src/modules/writeback/backfill.service';

function sourceHashFor(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('BackfillService.backfillAreaPath', () => {
  it('returns all-zero counts and makes no further calls when the area path has no work items', async () => {
    const queryIds = jest.fn().mockResolvedValue([]);
    const getWorkItemsBatch = jest.fn();
    const upsertDedupEntriesBatch = jest.fn();
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn(), record: jest.fn() } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 0, seeded: 0, skipped: 0, skippedReasons: {} });
    expect(getWorkItemsBatch).not.toHaveBeenCalled();
    expect(upsertDedupEntriesBatch).not.toHaveBeenCalled();
  });

  it('seeds idempotency + dedup for every backfillable-type item with real content', async () => {
    const queryIds = jest.fn().mockResolvedValue([100, 101]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 100, type: 'Feature', fields: { 'System.Title': 'T1', 'System.Description': 'D1' }, parentId: null },
      { id: 101, type: 'Requirement', fields: { 'System.Title': 'T2', 'System.Description': 'D2' }, parentId: 100 },
    ]);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const lookup = jest.fn().mockResolvedValue(null);
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup, record } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 2, seeded: 2, skipped: 0, skippedReasons: {} });
    expect(queryIds).toHaveBeenCalledWith({ 'System.AreaPath': 'Project\\Area1' }, undefined);
    expect(record).toHaveBeenCalledWith(sourceHashFor('D1'), null, 'Project\\Area1', 100);
    expect(record).toHaveBeenCalledWith(sourceHashFor('D2'), null, 'Project\\Area1', 101);
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '100', text: 'D1', areaPath: 'Project\\Area1' },
      { itemId: '101', text: 'D2', areaPath: 'Project\\Area1' },
    ]);
  });

  it('skips a work item whose type is not Epic/Feature/Requirement', async () => {
    const queryIds = jest.fn().mockResolvedValue([200]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 200, type: 'Bug', fields: { 'System.Title': 'A real bug', 'System.Description': 'Repro steps' }, parentId: null },
    ]);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn(), record: jest.fn() } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 1, seeded: 0, skipped: 1, skippedReasons: { 'unsupported type': 1 } });
    expect(upsertDedupEntriesBatch).not.toHaveBeenCalled();
  });

  it('falls back to Title when Description is blank, and skips when both are blank', async () => {
    const queryIds = jest.fn().mockResolvedValue([300, 301]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 300, type: 'Feature', fields: { 'System.Title': 'Title only' }, parentId: null },
      { id: 301, type: 'Feature', fields: {}, parentId: null },
    ]);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result.seeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons).toEqual({ 'no title or description': 1 });
    expect(record).toHaveBeenCalledWith(sourceHashFor('Title only'), null, 'Project\\Area1', 300);
  });

  it('does not re-record an item whose sourceHash already has an idempotency mapping', async () => {
    const queryIds = jest.fn().mockResolvedValue([400]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 400, type: 'Feature', fields: { 'System.Description': 'Already known' }, parentId: null },
    ]);
    const record = jest.fn();
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      { lookup: jest.fn().mockResolvedValue(400), record } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(record).not.toHaveBeenCalled();
    expect(result.seeded).toBe(1); // still counted as seeded -- dedup vector store upsert still happens
  });

  it('does not let one idempotency record failure abort the batch', async () => {
    const queryIds = jest.fn().mockResolvedValue([500, 501]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 500, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
      { id: 501, type: 'Feature', fields: { 'System.Description': 'D2' }, parentId: null },
    ]);
    const record = jest.fn().mockRejectedValueOnce(new Error('unique constraint violation')).mockResolvedValueOnce(undefined);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result.seeded).toBe(2); // both items still counted -- the failure was best-effort only
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '500', text: 'D1', areaPath: 'Project\\Area1' },
      { itemId: '501', text: 'D2', areaPath: 'Project\\Area1' },
    ]);
    consoleErrorSpy.mockRestore();
  });

  it('does not let a dedup batch upsert failure fail the whole backfill', async () => {
    const queryIds = jest.fn().mockResolvedValue([600]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 600, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const upsertDedupEntriesBatch = jest.fn().mockRejectedValue(new Error('ingestion unreachable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await expect(service.backfillAreaPath('Project\\Area1')).resolves.toEqual({
      scanned: 1,
      seeded: 1,
      skipped: 0,
      skippedReasons: {},
    });
    consoleErrorSpy.mockRestore();
  });

  it('runs idempotencyService.lookup calls concurrently, not one item at a time', async () => {
    // Regression: the previous sequential `for` loop awaited each item's
    // lookup (and best-effort record) before starting the next -- every
    // item's check is independent, so this serializes N round trips for no
    // reason. Track how many lookups are in flight simultaneously to prove
    // the new implementation actually overlaps them.
    const ids = [800, 801, 802, 803, 804, 805, 806, 807];
    const queryIds = jest.fn().mockResolvedValue(ids);
    const getWorkItemsBatch = jest.fn().mockResolvedValue(
      ids.map((id) => ({ id, type: 'Feature', fields: { 'System.Description': `D${id}` }, parentId: null })),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const lookup = jest.fn().mockImplementation(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => setTimeout(() => {
        inFlight -= 1;
        resolve(null);
      }, 10));
    });
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      { lookup, record: jest.fn().mockResolvedValue(undefined) } as any,
      4,
    );

    await service.backfillAreaPath('Project\\Area1');

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('preserves the original item order in the batched dedup upsert regardless of concurrent resolution order', async () => {
    const queryIds = jest.fn().mockResolvedValue([900, 901, 902]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 900, type: 'Feature', fields: { 'System.Description': 'D0' }, parentId: null },
      { id: 901, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
      { id: 902, type: 'Feature', fields: { 'System.Description': 'D2' }, parentId: null },
    ]);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const lookup = jest.fn().mockImplementation((sourceHash: string) => {
      // item 900's lookup resolves LAST despite being requested first.
      const delayMs = sourceHash === sourceHashFor('D0') ? 30 : 5;
      return new Promise((resolve) => setTimeout(() => resolve(null), delayMs));
    });
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup, record: jest.fn().mockResolvedValue(undefined) } as any,
      3,
    );

    await service.backfillAreaPath('Project\\Area1');

    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '900', text: 'D0', areaPath: 'Project\\Area1' },
      { itemId: '901', text: 'D1', areaPath: 'Project\\Area1' },
      { itemId: '902', text: 'D2', areaPath: 'Project\\Area1' },
    ]);
  });

  it('propagates an idempotencyService.lookup rejection (fails the whole backfill, same as before parallelization)', async () => {
    const queryIds = jest.fn().mockResolvedValue([950, 951]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 950, type: 'Feature', fields: { 'System.Description': 'D0' }, parentId: null },
      { id: 951, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const lookup = jest.fn().mockRejectedValue(new Error('db unreachable'));
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch: jest.fn() } as any,
      { lookup, record: jest.fn() } as any,
    );

    await expect(service.backfillAreaPath('Project\\Area1')).rejects.toThrow('db unreachable');
  });

  it('forwards the ADO credential through to queryIds and getWorkItemsBatch', async () => {
    const credential = { orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' };
    const queryIds = jest.fn().mockResolvedValue([700]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 700, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      { lookup: jest.fn().mockResolvedValue(null), record: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await service.backfillAreaPath('Project\\Area1', credential);

    expect(queryIds).toHaveBeenCalledWith({ 'System.AreaPath': 'Project\\Area1' }, credential);
    expect(getWorkItemsBatch).toHaveBeenCalledWith([700], credential);
  });
});
