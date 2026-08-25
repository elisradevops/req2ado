import { createHash } from 'crypto';
import { BackfillService } from '../src/modules/writeback/backfill.service';

function sourceHashFor(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Identity map -- CMMI-shaped, so every existing fixture's item.type
// ('Feature'/'Requirement' used directly as the real ADO type name) keeps
// passing unchanged. Tests exercising a non-CMMI project override this per
// call with a real mapping (e.g. Requirement -> 'User Story').
const CMMI_CATEGORIES = { Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' };

describe('BackfillService.backfillAreaPath', () => {
  it('returns all-zero counts and makes no further calls when the area path has no work items', async () => {
    const queryIds = jest.fn().mockResolvedValue([]);
    const getWorkItemsBatch = jest.fn();
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn();
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn(), record: jest.fn() } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 0, seeded: 0, skipped: 0, skippedReasons: {} });
    expect(getWorkItemsBatch).not.toHaveBeenCalled();
    expect(discoverWorkItemTypeCategories).not.toHaveBeenCalled();
    expect(upsertDedupEntriesBatch).not.toHaveBeenCalled();
  });

  it('seeds idempotency + dedup for every backfillable-type item with real content', async () => {
    const queryIds = jest.fn().mockResolvedValue([100, 101]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 100, type: 'Feature', fields: { 'System.Title': 'T1', 'System.Description': 'D1' }, parentId: null },
      { id: 101, type: 'Requirement', fields: { 'System.Title': 'T2', 'System.Description': 'D2' }, parentId: 100 },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const lookup = jest.fn().mockResolvedValue(null);
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup, record } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 2, seeded: 2, skipped: 0, skippedReasons: {} });
    expect(queryIds).toHaveBeenCalledWith({ 'System.AreaPath': 'Project\\Area1' }, 'Project', undefined);
    expect(discoverWorkItemTypeCategories).toHaveBeenCalledWith('Project', undefined);
    expect(record).toHaveBeenCalledWith(sourceHashFor('D1'), 'Project\\Area1', 100);
    expect(record).toHaveBeenCalledWith(sourceHashFor('D2'), 'Project\\Area1', 101);
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '100', text: 'D1', title: 'T1', areaPath: 'Project\\Area1' },
      { itemId: '101', text: 'D2', title: 'T2', areaPath: 'Project\\Area1' },
    ]);
  });

  it('strips ADO rich-text HTML from the description before sending it as dedup text, but hashes the raw HTML for the idempotency sourceHash', async () => {
    // Regression for a confirmed real gap: ADO's System.Description is rich-
    // text HTML ("<p>...</p>\n"), unlike req2ado's own always-plain
    // generated text -- embedding raw HTML on this seed side silently cost
    // ~2.5 similarity points on every future comparison. The sourceHash
    // (idempotency exact-match) must stay on the untouched raw HTML, or
    // every existing IdempotencyMapping row keyed on the old hash would
    // silently stop matching.
    const rawHtmlDescription = '<p>Lists the specific set of Standard Replacement Units. </p>\n';
    const queryIds = jest.fn().mockResolvedValue([647]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 647, type: 'Epic', fields: { 'System.Title': 'SRU Module Inventory', 'System.Description': rawHtmlDescription }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record } as any,
    );

    await service.backfillAreaPath('Project\\Area1');

    expect(record).toHaveBeenCalledWith(sourceHashFor(rawHtmlDescription), 'Project\\Area1', 647);
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      {
        itemId: '647',
        text: 'Lists the specific set of Standard Replacement Units.',
        title: 'SRU Module Inventory',
        areaPath: 'Project\\Area1',
      },
    ]);
  });

  it('uses the same stripped text for both title and text when Title is blank and Description is HTML', async () => {
    // Regression for a confirmed real bug: the title fallback previously
    // assigned the RAW (unstripped) description as title while `text` was
    // the stripped version -- the two halves of the title/description
    // blend no longer contained matching content, reintroducing the exact
    // HTML-noise penalty stripHtmlTags exists to eliminate, silently, only
    // for Title-blank items.
    const rawHtmlDescription = '<p>The unit shall survive drop testing. </p>\n';
    const queryIds = jest.fn().mockResolvedValue([648]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 648, type: 'Epic', fields: { 'System.Description': rawHtmlDescription }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await service.backfillAreaPath('Project\\Area1');

    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      {
        itemId: '648',
        text: 'The unit shall survive drop testing.',
        title: 'The unit shall survive drop testing.',
        areaPath: 'Project\\Area1',
      },
    ]);
  });

  it('falls back to a CMMI-shaped default type set when discoverWorkItemTypeCategories fails, instead of aborting the whole backfill', async () => {
    // Regression for a confirmed real bug: this call used to be a pure/
    // static Set check with zero network dependency -- a failure here must
    // degrade to the old hardcoded-Set behavior, not abort backfillAreaPath
    // entirely (which would 500 the direct POST /backfill route and
    // silently disable backfill for 24h via maybeBackfillAreaPath's own
    // catch, per pipeline.worker.ts).
    const queryIds = jest.fn().mockResolvedValue([649]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 649, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockRejectedValue(new Error('ADO unreachable'));
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record: jest.fn().mockResolvedValue(undefined) } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 1, seeded: 1, skipped: 0, skippedReasons: {} });
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '649', text: 'D1', title: 'D1', areaPath: 'Project\\Area1' },
    ]);
    consoleErrorSpy.mockRestore();
  });

  it('recognizes an Agile-template item ("User Story") as backfillable when discoverWorkItemTypeCategories maps Requirement to it', async () => {
    // Regression for the confirmed bug: 'Requirement' is req2ado's internal
    // category label, not necessarily the real ADO type name -- Agile's
    // Requirement-category type is 'User Story'. Before the fix, this item
    // would have been skipped as 'unsupported type' against a fixed
    // {'Epic','Feature','Requirement'} set.
    const queryIds = jest.fn().mockResolvedValue([110]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 110, type: 'User Story', fields: { 'System.Description': 'A real user story' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' });
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record: jest.fn().mockResolvedValue(undefined) } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 1, seeded: 1, skipped: 0, skippedReasons: {} });
  });

  it('still skips a real Bug even on an Agile-mapped project', async () => {
    const queryIds = jest.fn().mockResolvedValue([111]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 111, type: 'Bug', fields: { 'System.Description': 'Repro steps' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' });
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn(), record: jest.fn() } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 1, seeded: 0, skipped: 1, skippedReasons: { 'unsupported type': 1 } });
    expect(upsertDedupEntriesBatch).not.toHaveBeenCalled();
  });

  it('does not call discoverWorkItemTypeCategories when getWorkItemsBatch returns no items', async () => {
    const queryIds = jest.fn().mockResolvedValue([120]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch: jest.fn() } as any,
      { lookup: jest.fn(), record: jest.fn() } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result).toEqual({ scanned: 0, seeded: 0, skipped: 0, skippedReasons: {} });
    expect(discoverWorkItemTypeCategories).not.toHaveBeenCalled();
  });

  it('skips a work item whose type is not Epic/Feature/Requirement', async () => {
    const queryIds = jest.fn().mockResolvedValue([200]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 200, type: 'Bug', fields: { 'System.Title': 'A real bug', 'System.Description': 'Repro steps' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
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
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result.seeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons).toEqual({ 'no title or description': 1 });
    expect(record).toHaveBeenCalledWith(sourceHashFor('Title only'), 'Project\\Area1', 300);
  });

  it('does not re-record an item whose sourceHash already has an idempotency mapping', async () => {
    const queryIds = jest.fn().mockResolvedValue([400]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 400, type: 'Feature', fields: { 'System.Description': 'Already known' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const record = jest.fn();
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
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
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const record = jest.fn().mockRejectedValueOnce(new Error('unique constraint violation')).mockResolvedValueOnce(undefined);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record } as any,
    );

    const result = await service.backfillAreaPath('Project\\Area1');

    expect(result.seeded).toBe(2); // both items still counted -- the failure was best-effort only
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '500', text: 'D1', title: 'D1', areaPath: 'Project\\Area1' },
      { itemId: '501', text: 'D2', title: 'D2', areaPath: 'Project\\Area1' },
    ]);
    consoleErrorSpy.mockRestore();
  });

  it('does not let a dedup batch upsert failure fail the whole backfill', async () => {
    const queryIds = jest.fn().mockResolvedValue([600]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 600, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockRejectedValue(new Error('ingestion unreachable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
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
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
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
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
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
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const lookup = jest.fn().mockImplementation((sourceHash: string) => {
      // item 900's lookup resolves LAST despite being requested first.
      const delayMs = sourceHash === sourceHashFor('D0') ? 30 : 5;
      return new Promise((resolve) => setTimeout(() => resolve(null), delayMs));
    });
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup, record: jest.fn().mockResolvedValue(undefined) } as any,
      3,
    );

    await service.backfillAreaPath('Project\\Area1');

    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '900', text: 'D0', title: 'D0', areaPath: 'Project\\Area1' },
      { itemId: '901', text: 'D1', title: 'D1', areaPath: 'Project\\Area1' },
      { itemId: '902', text: 'D2', title: 'D2', areaPath: 'Project\\Area1' },
    ]);
  });

  it('propagates an idempotencyService.lookup rejection (fails the whole backfill, same as before parallelization)', async () => {
    const queryIds = jest.fn().mockResolvedValue([950, 951]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 950, type: 'Feature', fields: { 'System.Description': 'D0' }, parentId: null },
      { id: 951, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const lookup = jest.fn().mockRejectedValue(new Error('db unreachable'));
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch: jest.fn() } as any,
      { lookup, record: jest.fn() } as any,
    );

    await expect(service.backfillAreaPath('Project\\Area1')).rejects.toThrow('db unreachable');
  });

  it('forwards the ADO credential through to queryIds, discoverWorkItemTypeCategories, and getWorkItemsBatch', async () => {
    const credential = { orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' };
    const queryIds = jest.fn().mockResolvedValue([700]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 700, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      { lookup: jest.fn().mockResolvedValue(null), record: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await service.backfillAreaPath('Project\\Area1', credential);

    expect(queryIds).toHaveBeenCalledWith({ 'System.AreaPath': 'Project\\Area1' }, 'Project', credential);
    expect(discoverWorkItemTypeCategories).toHaveBeenCalledWith('Project', credential);
    expect(getWorkItemsBatch).toHaveBeenCalledWith([700], credential);
  });

  it('derives the project from the area path\'s first segment for a nested area path', async () => {
    const queryIds = jest.fn().mockResolvedValue([]);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch: jest.fn(), discoverWorkItemTypeCategories: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn() } as any,
      { lookup: jest.fn(), record: jest.fn() } as any,
    );

    await service.backfillAreaPath('Project\\Team\\SubArea');

    expect(queryIds).toHaveBeenCalledWith({ 'System.AreaPath': 'Project\\Team\\SubArea' }, 'Project', undefined);
  });

  it('seeds idempotency and dedup entries under the ITEM\'s own System.AreaPath, not the requested area path, for a subtree match', async () => {
    // Regression for a confirmed real bug: queryIds now matches the whole
    // area-path subtree (WIQL UNDER), so an item can legitimately live
    // under a NESTED area path different from the one requested. Both
    // IdempotencyMapping and the dedup vector store are scoped by exact
    // area-path string match -- seeding under the requested path instead
    // of the item's real one means a later job against the item's actual
    // area path never finds this entry.
    const queryIds = jest.fn().mockResolvedValue([650]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      {
        id: 650,
        type: 'Feature',
        fields: { 'System.Title': 'Nested Item', 'System.Description': 'D1', 'System.AreaPath': 'Project\\Parent\\Child' },
        parentId: null,
      },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const lookup = jest.fn().mockResolvedValue(null);
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup, record } as any,
    );

    await service.backfillAreaPath('Project\\Parent');

    expect(lookup).toHaveBeenCalledWith(sourceHashFor('D1'), 'Project\\Parent\\Child');
    expect(record).toHaveBeenCalledWith(sourceHashFor('D1'), 'Project\\Parent\\Child', 650);
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '650', text: 'D1', title: 'Nested Item', areaPath: 'Project\\Parent\\Child' },
    ]);
  });

  it('falls back to the requested area path when an item has no System.AreaPath field at all', async () => {
    const queryIds = jest.fn().mockResolvedValue([651]);
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 651, type: 'Feature', fields: { 'System.Description': 'D1' }, parentId: null },
    ]);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue(CMMI_CATEGORIES);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const service = new BackfillService(
      { queryIds, getWorkItemsBatch, discoverWorkItemTypeCategories } as any,
      { upsertDedupEntriesBatch } as any,
      { lookup: jest.fn().mockResolvedValue(null), record: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await service.backfillAreaPath('Project\\Parent');

    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '651', text: 'D1', title: 'D1', areaPath: 'Project\\Parent' },
    ]);
  });
});
