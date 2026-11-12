import {
  DEDUP_LOG_MAX_ROWS_PER_JOB,
  DEDUP_LOG_MAX_TEXT_CHARS,
  deleteDecisionsOlderThan,
  listDecisions,
  recordDecisions,
  selectRowsToLog,
  setReviewerOutcomes,
  toCsv,
  type DedupCheckObservation,
} from '../src/modules/pipeline/dedup-decision-log';

const obs = (overrides: Partial<DedupCheckObservation> = {}): DedupCheckObservation => ({
  localId: 'n1', itemType: 'Requirement', areaPath: 'P\\A', title: 'Title', text: 'The unit shall survive a drop.',
  isDuplicate: true, matchedItemId: '123', matchedText: 'The unit shall survive a drop.', similarity: 0.95, judgeVerdict: 'redundant', ...overrides,
});

describe('selectRowsToLog', () => {
  it('logs a skipped item, with both texts, the score, the verdict and the threshold in force', () => {
    const [row] = selectRowsToLog('job-1', 'area_path', 0.9, [obs()]);

    expect(row).toMatchObject({
      jobId: 'job-1', localId: 'n1', itemType: 'Requirement', areaPath: 'P\\A', scope: 'area_path', candidateTitle: 'Title',
      candidateText: 'The unit shall survive a drop.', matchedAdoId: 123, matchedText: 'The unit shall survive a drop.',
      similarity: 0.95, threshold: 0.9, judgeVerdict: 'redundant', decision: 'skipped',
    });
  });

  it('logs a close match the judge did not confirm, as not skipped', () => {
    const [row] = selectRowsToLog('job-1', 'area_path', 0.9, [obs({ isDuplicate: false, judgeVerdict: 'distinct', similarity: 0.93 })]);

    expect(row).toMatchObject({ decision: 'not_skipped', judgeVerdict: 'distinct' });
  });

  it('logs nothing below the threshold: only pairs at or above it are written', () => {
    expect(selectRowsToLog('job-1', 'area_path', 0.9, [obs({ isDuplicate: false, similarity: 0.89, judgeVerdict: null })])).toEqual([]);
    expect(selectRowsToLog('job-1', 'area_path', 0.9, [obs({ similarity: null })])).toEqual([]);
    expect(selectRowsToLog('job-1', 'area_path', 0.9, [obs({ isDuplicate: false, similarity: 0.9, judgeVerdict: 'distinct' })])).toHaveLength(1);
  });

  it('uses 0.90 when the job ran without a threshold of its own', () => {
    expect(selectRowsToLog('job-1', 'area_path', undefined, [obs({ isDuplicate: false, similarity: 0.89, judgeVerdict: null })])).toEqual([]);
    expect(selectRowsToLog('job-1', 'area_path', undefined, [obs({ similarity: 0.9 })])[0].threshold).toBeNull();
  });

  it('keeps a match whose id is not a number, without an id', () => {
    const [row] = selectRowsToLog('job-1', 'area_path', 0.9, [obs({ matchedItemId: 'not-a-number' })]);

    expect(row.matchedAdoId).toBeNull();
  });

  it('cuts each text at the limit, so one huge description cannot fill the table', () => {
    const [row] = selectRowsToLog('job-1', 'area_path', 0.9, [obs({ text: 'x'.repeat(DEDUP_LOG_MAX_TEXT_CHARS + 500), matchedText: 'y'.repeat(DEDUP_LOG_MAX_TEXT_CHARS + 1) })]);

    expect(row.candidateText).toHaveLength(DEDUP_LOG_MAX_TEXT_CHARS);
    expect(row.matchedText).toHaveLength(DEDUP_LOG_MAX_TEXT_CHARS);
  });

  it('keeps at most a fixed number of rows per job, the closest matches first', () => {
    const many = Array.from({ length: DEDUP_LOG_MAX_ROWS_PER_JOB + 20 }, (_, i) => obs({ localId: `n${i}`, similarity: 0.9 + (i % 100) / 1000 }));

    const rows = selectRowsToLog('job-1', 'area_path', 0.9, many);

    expect(rows).toHaveLength(DEDUP_LOG_MAX_ROWS_PER_JOB);
    const lowestKept = Math.min(...rows.map((r) => r.similarity));
    const highestDropped = Math.max(...many.filter((m) => !rows.some((r) => r.localId === m.localId)).map((m) => m.similarity as number));
    expect(lowestKept).toBeGreaterThanOrEqual(highestDropped);
  });
});

describe('recordDecisions', () => {
  it('writes the rows in one call', async () => {
    const prisma = { dedupDecisionLog: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const rows = selectRowsToLog('job-1', 'area_path', 0.9, [obs()]);

    await recordDecisions(prisma as any, rows);

    expect(prisma.dedupDecisionLog.createMany).toHaveBeenCalledWith({ data: rows });
  });

  it('writes nothing when there is nothing to write', async () => {
    const prisma = { dedupDecisionLog: { createMany: jest.fn() } };

    await recordDecisions(prisma as any, []);

    expect(prisma.dedupDecisionLog.createMany).not.toHaveBeenCalled();
  });

  it('never fails the job: a write that fails is logged and skipped', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const prisma = { dedupDecisionLog: { createMany: jest.fn().mockRejectedValue(new Error('db down')) } };

    await expect(recordDecisions(prisma as any, selectRowsToLog('job-1', 'area_path', 0.9, [obs()]))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('setReviewerOutcomes', () => {
  it('marks what the reviewer did with each skip, for the entries of one job', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { dedupDecisionLog: { updateMany } };

    await setReviewerOutcomes(prisma as any, 'job-1', { keptSkipped: ['a', 'b'], createdAnyway: ['c'], undone: ['d'] });

    expect(updateMany).toHaveBeenCalledWith({ where: { jobId: 'job-1', localId: { in: ['a', 'b'] }, decision: 'skipped' }, data: { reviewerOutcome: 'kept_skipped', reviewerAt: expect.any(Date) } });
    expect(updateMany).toHaveBeenCalledWith({ where: { jobId: 'job-1', localId: { in: ['c'] }, decision: 'skipped' }, data: { reviewerOutcome: 'created_anyway', reviewerAt: expect.any(Date) } });
    expect(updateMany).toHaveBeenCalledWith({ where: { jobId: 'job-1', localId: { in: ['d'] }, decision: 'skipped' }, data: { reviewerOutcome: null, reviewerAt: null } });
  });

  it('skips empty groups, and never throws', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const updateMany = jest.fn().mockRejectedValue(new Error('db down'));
    const prisma = { dedupDecisionLog: { updateMany } };

    await expect(setReviewerOutcomes(prisma as any, 'job-1', { keptSkipped: ['a'] })).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('deleteDecisionsOlderThan', () => {
  it('removes rows older than the cutoff and says how many', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 7 });
    const cutoff = new Date('2026-10-01T00:00:00Z');

    await expect(deleteDecisionsOlderThan({ dedupDecisionLog: { deleteMany } } as any, cutoff)).resolves.toBe(7);
    expect(deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: cutoff } } });
  });
});

describe('listDecisions', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = { dedupDecisionLog: { findMany } };
  beforeEach(() => findMany.mockClear());

  it('filters by date range, job and outcome, newest first', async () => {
    const since = new Date('2026-11-01T00:00:00Z');
    const until = new Date('2026-11-30T00:00:00Z');

    await listDecisions(prisma as any, { since, until, jobId: 'job-1', outcome: 'created_anyway', limit: 50 });

    expect(findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: since, lte: until }, jobId: 'job-1', reviewerOutcome: 'created_anyway' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('has a default and a maximum page, so one request cannot read the whole table', async () => {
    await listDecisions(prisma as any, {});
    await listDecisions(prisma as any, { limit: 100000 });
    await listDecisions(prisma as any, { limit: -5 });

    expect(findMany.mock.calls.map((c) => c[0].take)).toEqual([200, 1000, 1]);
  });

  it('can ask for the pairs a reviewer has not decided yet', async () => {
    await listDecisions(prisma as any, { outcome: 'undecided' });

    expect(findMany.mock.calls[0][0].where).toMatchObject({ reviewerOutcome: null });
  });
});

describe('toCsv', () => {
  it('writes a header and one line per row, quoting what needs it, with Hebrew intact', () => {
    const csv = toCsv([
      { id: '1', jobId: 'j', localId: 'n1', itemType: 'Requirement', areaPath: 'P\\A', scope: 'area_path', candidateTitle: 'שלום, "עולם"', candidateText: 'line one\nline two', matchedAdoId: 5, matchedText: null, similarity: 0.95, threshold: 0.9, judgeVerdict: 'redundant', decision: 'skipped', reviewerOutcome: null, reviewerAt: null, createdAt: new Date('2026-11-12T10:00:00Z') },
    ]);

    const [header, ...rest] = csv.split('\r\n');
    expect(header).toBe('id,jobId,localId,itemType,areaPath,scope,candidateTitle,candidateText,matchedAdoId,matchedText,similarity,threshold,judgeVerdict,decision,reviewerOutcome,reviewerAt,createdAt');
    expect(rest.join('\r\n')).toContain('"שלום, ""עולם"""');
    expect(rest.join('\r\n')).toContain('"line one\nline two"');
    expect(rest.join('\r\n')).toContain('2026-11-12T10:00:00.000Z');
  });
});
