import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { JobsService } from '../src/modules/pipeline/jobs.service';
import { RewriteCheckCache } from '../src/modules/pipeline/rewrite-check-cache';

// The service opens a queue connection when it is built: stubbed here, so a unit test opens none and jest can exit.
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ on: jest.fn(), add: jest.fn(), close: jest.fn(), waitUntilReady: jest.fn() })),
}));

// A job row that persists what the service writes, so a whole sequence (suggest, accept, undo) runs against the real service code.
function makeService(initial: Record<string, unknown>[], extra: Record<string, unknown> = {}, ingestion: Record<string, unknown> = {}) {
  const job = { id: 'job-1', status: 'diff_ready', userId: 'user-1', model: 'm1', diffVersion: 1, dryRunDiff: initial, ...extra } as Record<string, unknown>;
  const prisma = {
    createdItemMapping: { findUnique: jest.fn().mockResolvedValue(null) },
    job: {
      findUnique: jest.fn().mockImplementation(async () => structuredClone(job)),
      updateMany: jest.fn().mockImplementation(async ({ data }: { data: { dryRunDiff: unknown } }) => {
        job.dryRunDiff = structuredClone(data.dryRunDiff);
        job.diffVersion = (job.diffVersion as number) + 1;
        return { count: 1 };
      }),
      update: jest.fn(),
    },
  };
  const service = new JobsService(prisma as any, {} as any, {} as any, ingestion as any, 'redis://unused');
  return { service, prisma, job };
}

const entry = {
  localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Lock time', description: 'The receiver shall lock.',
  action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
  qualityScore: 45, qualityIssues: ['not_testable'], qualityCategoryScores: { Testable: 35 }, qualityConfidence: 'high' as const, qualityStale: false,
};

describe('RewriteCheckCache', () => {
  const key = (over: Partial<Parameters<typeof RewriteCheckCache.key>[0]> = {}) =>
    RewriteCheckCache.key({ jobId: 'j', localId: 'n', title: 't', description: 'd', proposedTitle: null, proposedDescription: 'p', ...over });

  it('keys on the job, the item and both texts, so an edit or another suggestion never hits', () => {
    const base = key();
    expect(key()).toBe(base);
    for (const change of [{ jobId: 'x' }, { localId: 'x' }, { title: 'x' }, { description: 'x' }, { proposedTitle: 'x' }, { proposedDescription: 'x' }]) {
      expect(key(change)).not.toBe(base);
    }
  });

  it('does not run two fields together into the same key', () => {
    expect(key({ title: 'ab', description: 'c' })).not.toBe(key({ title: 'a', description: 'bc' }));
  });

  it('forgets an entry after its time, and drops the least recently used past its size', () => {
    let now = 0;
    const cache = new RewriteCheckCache<number>(1000, 2, () => now);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('c', 3); // b goes
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    now = 1001;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});

describe('JobsService.checkRewrite: remembering a scored comparison', () => {
  const comparison = { before: { score: 45 }, after: { score: 78 }, delta: 33, categoryDeltas: {}, warnings: [] };

  it('asks the scorer once for the same suggestion, and again when the item or the suggestion differs', async () => {
    const compareRewrite = jest.fn().mockResolvedValue(comparison);
    const { service, job } = makeService([entry], {}, { compareRewrite });
    const proposal = { proposedTitle: null, proposedDescription: 'The receiver shall lock within 5 ms.' };

    expect(await service.checkRewrite('job-1', 'n0', proposal)).toEqual(comparison);
    expect(await service.checkRewrite('job-1', 'n0', proposal)).toEqual(comparison);
    expect(compareRewrite).toHaveBeenCalledTimes(1);

    await service.checkRewrite('job-1', 'n0', { ...proposal, proposedDescription: 'A different suggestion.' });
    expect(compareRewrite).toHaveBeenCalledTimes(2);

    job.dryRunDiff = [{ ...entry, description: 'The item was edited.' }];
    await service.checkRewrite('job-1', 'n0', proposal);
    expect(compareRewrite).toHaveBeenCalledTimes(3);
  });

  it('does not keep a warnings-only answer, or a comparison without a score', async () => {
    const compareRewrite = jest.fn().mockResolvedValue({ ...comparison, delta: null, before: { score: null }, after: { score: null } });
    const { service } = makeService([entry], {}, { compareRewrite });
    const proposal = { proposedDescription: 'A text.' };
    await service.checkRewrite('job-1', 'n0', proposal);
    await service.checkRewrite('job-1', 'n0', proposal);
    expect(compareRewrite).toHaveBeenCalledTimes(2); // an answer without a score is worth asking for again

    const scored = jest.fn().mockResolvedValue(comparison);
    const other = makeService([entry], {}, { compareRewrite: scored }).service;
    await other.checkRewrite('job-1', 'n0', { ...proposal, warningsOnly: true });
    await other.checkRewrite('job-1', 'n0', { ...proposal, warningsOnly: true });
    expect(scored).toHaveBeenCalledTimes(2);
    await other.checkRewrite('job-1', 'n0', proposal); // the scored call is not satisfied by a warnings-only one
    expect(scored).toHaveBeenCalledTimes(3);
  });
});

describe('JobsService suggestions: set, decide, accept with a snapshot, undo', () => {
  it('keeps the newest suggestion with the item as pending, replacing an older one', async () => {
    const { service } = makeService([entry]);
    const first = await service.setSuggestion('job-1', 'n0', { proposedDescription: 'First.' });
    expect(first[0].suggestion).toMatchObject({ proposedDescription: 'First.', proposedTitle: null, decision: 'pending' });
    const second = await service.setSuggestion('job-1', 'n0', { proposedTitle: 'Second title', proposedDescription: 'Second.' });
    expect(second[0].suggestion?.proposedDescription).toBe('Second.');
    expect(second[0].suggestion?.id).not.toBe(first[0].suggestion?.id);
  });

  it('refuses a blank suggestion, a missing item and an item that is not a new one', async () => {
    const { service } = makeService([entry, { ...entry, localId: 'r1', action: 'reuse' }]);
    await expect(service.setSuggestion('job-1', 'n0', { proposedTitle: '  ', proposedDescription: null })).rejects.toThrow(BadRequestException);
    await expect(service.setSuggestion('job-1', 'zz', { proposedDescription: 'x' })).rejects.toThrow(NotFoundException);
    await expect(service.setSuggestion('job-1', 'r1', { proposedDescription: 'x' })).rejects.toThrow(BadRequestException);
  });

  it('records a rejection or a parking, and ignores a decision for a suggestion that was replaced', async () => {
    const { service } = makeService([entry]);
    const set = await service.setSuggestion('job-1', 'n0', { proposedDescription: 'First.' });
    const id = set[0].suggestion!.id;
    const replaced = await service.setSuggestion('job-1', 'n0', { proposedDescription: 'Second.' });
    const stale = await service.decideSuggestion('job-1', 'n0', 'rejected', id); // for the first one
    expect(stale[0].suggestion?.decision).toBe('pending');
    const current = await service.decideSuggestion('job-1', 'n0', 'discussed', replaced[0].suggestion!.id);
    expect(current[0].suggestion?.decision).toBe('discussed');
  });

  it('applies a suggestion with a snapshot of what it replaced, marks it accepted, and an Undo puts back the text and the scores', async () => {
    const { service } = makeService([entry]);
    const set = await service.setSuggestion('job-1', 'n0', { proposedTitle: 'Lock time', proposedDescription: 'The receiver shall lock within 5 ms.' });
    const suggestionId = set[0].suggestion!.id;

    const applied = await service.editDiffEntry('job-1', 'n0', { title: 'Lock time', description: 'The receiver shall lock within 5 ms.', snapshot: true, suggestionId });
    expect(applied[0].description).toBe('The receiver shall lock within 5 ms.');
    expect(applied[0].qualityStale).toBe(true); // the usual rule: a changed text makes the score stale
    expect(applied[0].suggestion?.decision).toBe('accepted');
    expect(applied[0].previousRevision).toMatchObject({ description: 'The receiver shall lock.', qualityScore: 45, qualityCategoryScores: { Testable: 35 }, qualityStale: false });

    const undone = await service.revertDiffEntry('job-1', 'n0');
    expect(undone[0]).toMatchObject({ description: 'The receiver shall lock.', qualityScore: 45, qualityIssues: ['not_testable'], qualityStale: false, previousRevision: null });
    expect(undone[0].suggestion?.decision).toBe('pending'); // reviewable again
  });

  it('takes no snapshot for an ordinary edit, and a title-only change is snapshotted too', async () => {
    const { service } = makeService([entry]);
    const plain = await service.editDiffEntry('job-1', 'n0', { description: 'Edited by hand.' });
    expect(plain[0].previousRevision).toBeUndefined();
    const titleOnly = await service.editDiffEntry('job-1', 'n0', { title: 'A new title', snapshot: true });
    expect(titleOnly[0].previousRevision).toMatchObject({ title: 'Lock time', description: 'Edited by hand.' });
  });

  it('does not mark a suggestion accepted when its id no longer matches', async () => {
    const { service } = makeService([entry]);
    await service.setSuggestion('job-1', 'n0', { proposedDescription: 'x' });
    const result = await service.editDiffEntry('job-1', 'n0', { description: 'y', snapshot: true, suggestionId: 'not-it' });
    expect(result[0].suggestion?.decision).toBe('pending');
  });

  it('refuses an Undo once the item was edited since, and when there is nothing to undo', async () => {
    const { service } = makeService([entry]);
    await expect(service.revertDiffEntry('job-1', 'n0')).rejects.toThrow(ConflictException);
    await service.editDiffEntry('job-1', 'n0', { description: 'Applied text.', snapshot: true });
    await service.editDiffEntry('job-1', 'n0', { description: 'Edited again by the reviewer.' });
    await expect(service.revertDiffEntry('job-1', 'n0')).rejects.toThrow(/edited after the suggestion was applied/);
  });

  it('refuses all of it for an item already written, and for a job that is not in review', async () => {
    const written = makeService([entry]);
    written.prisma.createdItemMapping.findUnique.mockResolvedValue({ id: 'm' });
    await expect(written.service.setSuggestion('job-1', 'n0', { proposedDescription: 'x' })).rejects.toThrow(BadRequestException);
    await expect(written.service.revertDiffEntry('job-1', 'n0')).rejects.toThrow(BadRequestException);

    const closed = makeService([entry], { status: 'succeeded' });
    await expect(closed.service.setSuggestion('job-1', 'n0', { proposedDescription: 'x' })).rejects.toThrow(ConflictException);
    await expect(closed.service.decideSuggestion('job-1', 'n0', 'rejected')).rejects.toThrow(ConflictException);
  });
});
