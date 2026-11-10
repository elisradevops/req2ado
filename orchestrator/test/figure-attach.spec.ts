import { attachFigures, sanitizeFigureError } from '../src/modules/pipeline/figure-attach';

type Row = { id: string; figureId: string; mimeType: string; bytes: Buffer };

function makeFakes(figureIds: string[], opts: { uploadError?: (adoId: number, figureId: string) => Error | undefined; deleteError?: Error; auditError?: Error } = {}) {
  const rows: Row[] = figureIds.map((figureId) => ({ id: `row-${figureId}`, figureId, mimeType: 'image/png', bytes: Buffer.from('x') }));
  const audits: string[] = [];
  const deleted: string[] = [];
  const uploads: { adoId: number; fileName: string }[] = [];
  let inFlight = 0;
  const inFlightByAdoId = new Map<number, number>();
  let maxInFlight = 0;
  let maxSameItem = 0;
  const prisma = {
    jobFigureFile: {
      findMany: jest.fn(async () => rows),
      deleteMany: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (opts.deleteError) throw opts.deleteError;
        deleted.push(where.id);
      }),
    },
    auditEntry: {
      create: jest.fn(async ({ data }: { data: { message: string } }) => {
        if (opts.auditError) throw opts.auditError;
        audits.push(data.message);
      }),
    },
  };
  const mcpClient = {
    uploadAttachment: jest.fn(async (adoId: number, fileName: string) => {
      inFlight += 1;
      const same = (inFlightByAdoId.get(adoId) ?? 0) + 1;
      inFlightByAdoId.set(adoId, same);
      maxInFlight = Math.max(maxInFlight, inFlight);
      maxSameItem = Math.max(maxSameItem, same);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      inFlightByAdoId.set(adoId, same - 1);
      const figureId = fileName.split('.')[0];
      const err = opts.uploadError?.(adoId, figureId);
      if (err) throw err;
      uploads.push({ adoId, fileName });
    }),
  };
  return { prisma, mcpClient, audits, deleted, uploads, stats: () => ({ maxInFlight, maxSameItem }) };
}

function run(fakes: ReturnType<typeof makeFakes>, over: Record<string, unknown> = {}) {
  const diff = (over.diff as never) ?? [
    { localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1', 'f2', 'f3'] },
    { localId: 'b', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f4', 'f5'] },
  ];
  return attachFigures(
    { prisma: fakes.prisma as never, mcpClient: fakes.mcpClient as never, writeConcurrency: (over.writeConcurrency as number) ?? 8 },
    {
      jobId: 'job-1',
      diff,
      isExcluded: (over.isExcluded as never) ?? (() => false),
      eligibleAdoIdByLocalId: (over.eligible as Map<string, number>) ?? new Map([['a', 100], ['b', 200]]),
      figureNameByFigureId: new Map(),
      project: 'P',
      credential: over.credential as never,
    },
  );
}

describe('attachFigures', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('returns attached count, deletes rows and writes no audit entry when everything succeeds', async () => {
    const fakes = makeFakes(['f1', 'f2', 'f3', 'f4', 'f5']);
    const result = await run(fakes);
    expect(result).toEqual({ attached: 5, failed: [] });
    expect(fakes.deleted.sort()).toEqual(['row-f1', 'row-f2', 'row-f3', 'row-f4', 'row-f5']);
    expect(fakes.audits).toEqual([]);
  });

  it('does nothing when no figure rows are stored', async () => {
    const fakes = makeFakes([]);
    expect(await run(fakes)).toEqual({ attached: 0, failed: [] });
    expect(fakes.mcpClient.uploadAttachment).not.toHaveBeenCalled();
  });

  it('writes the exact audit text for one failure', async () => {
    const fakes = makeFakes(['f1'], { uploadError: () => new Error('boom happened') });
    const diff = [{ localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1'] }];
    const result = await run(fakes, { diff });
    expect(result).toEqual({ attached: 0, failed: [{ figureId: 'f1', adoId: 100 }] });
    expect(fakes.audits).toEqual(["1 figure attachment(s) failed (first error: boom happened): f1 on #100; add them from the item's Figures section"]);
    expect(fakes.deleted).toEqual([]);
  });

  it('lists at most 5 ids and says how many more for 7 failures', async () => {
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
    const fakes = makeFakes(ids, { uploadError: () => new Error('nope') });
    const diff = [{ localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ids }];
    const result = await run(fakes, { diff });
    expect(result.failed).toHaveLength(7);
    expect(fakes.audits).toEqual([
      "7 figure attachment(s) failed (first error: nope): f1 on #100, f2 on #100, f3 on #100, f4 on #100, f5 on #100 and 2 more; add them from the item's Figures section",
    ]);
  });

  it('adds the size hint only for size-like errors', async () => {
    for (const [message, hint] of [['HTTP 413 Request Entity Too Large', true], ['attachment too large', true], ['connection reset', false]] as const) {
      const fakes = makeFakes(['f1'], { uploadError: () => new Error(message) });
      const diff = [{ localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1'] }];
      await run(fakes, { diff });
      expect(fakes.audits[0].includes('ADO may limit attachment size: the Azure DevOps Server default is 4 MB; ')).toBe(hint);
    }
  });

  it('redacts URLs and the PAT in the audit text', async () => {
    const pat = 'secret-pat-value';
    const fakes = makeFakes(['f1'], { uploadError: () => new Error(`PATCH https://dev.azure.com/org/_apis/x failed with ${pat} Bearer abc123`) });
    const diff = [{ localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1'] }];
    await run(fakes, { diff, credential: { orgUrl: 'https://dev.azure.com/org', pat } });
    expect(fakes.audits[0]).toContain('first error: PATCH [url] failed with *** ***');
    expect(fakes.audits[0]).not.toContain(pat);
    expect(fakes.audits[0]).not.toContain('dev.azure.com');
  });

  it('does not count a failed row delete as a failed attachment', async () => {
    const fakes = makeFakes(['f1'], { deleteError: new Error('already gone') });
    const diff = [{ localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1'] }];
    const result = await run(fakes, { diff });
    expect(result).toEqual({ attached: 1, failed: [] });
    expect(fakes.audits).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Figure row removal failed for ADO work item 100, figure f1'), expect.any(Error));
  });

  it('still returns the failures when the audit write itself fails', async () => {
    const fakes = makeFakes(['f1'], { uploadError: () => new Error('x'), auditError: new Error('db down') });
    const diff = [{ localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1'] }];
    await expect(run(fakes, { diff })).resolves.toEqual({ attached: 0, failed: [{ figureId: 'f1', adoId: 100 }] });
  });

  it('keeps a failing figure from stopping the others', async () => {
    const fakes = makeFakes(['f1', 'f2'], { uploadError: (_a, figureId) => (figureId === 'f1' ? new Error('bad') : undefined) });
    const diff = [{ localId: 'a', type: 'Requirement', action: 'create', existingAdoId: null, figureIds: ['f1', 'f2'] }];
    expect(await run(fakes, { diff })).toEqual({ attached: 1, failed: [{ figureId: 'f1', adoId: 100 }] });
    expect(fakes.deleted).toEqual(['row-f2']);
  });

  it('uploads one item\'s figures one after another but different items concurrently', async () => {
    const fakes = makeFakes(['f1', 'f2', 'f3', 'f4', 'f5']);
    await run(fakes);
    expect(fakes.stats().maxSameItem).toBe(1);
    expect(fakes.stats().maxInFlight).toBe(2);
  });

  it('honours writeConcurrency across items', async () => {
    const fakes = makeFakes(['f1', 'f2', 'f3', 'f4', 'f5']);
    await run(fakes, { writeConcurrency: 1 });
    expect(fakes.stats().maxInFlight).toBe(1);
  });

  it('attaches nothing for excluded or non-eligible entries', async () => {
    const fakes = makeFakes(['f1', 'f2', 'f3', 'f4', 'f5']);
    const result = await run(fakes, { isExcluded: (e: { localId: string }) => e.localId === 'a', eligible: new Map([['a', 100]]) });
    expect(result).toEqual({ attached: 0, failed: [] });
    expect(fakes.mcpClient.uploadAttachment).not.toHaveBeenCalled();
    expect(fakes.deleted).toEqual([]);
  });
});

describe('sanitizeFigureError', () => {
  it('collapses whitespace, masks long tokens and truncates to 120 chars', () => {
    expect(sanitizeFigureError('a   b')).toBe('a b');
    expect(sanitizeFigureError(`tok ${'A'.repeat(45)}`)).toBe('tok ***');
    expect(sanitizeFigureError('zz '.repeat(100))).toHaveLength(120);
  });
});
