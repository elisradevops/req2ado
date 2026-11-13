import { describe, it, expect } from 'vitest';
import { groupJobs, isStaleJob, shortJobId, STALE_AFTER_DAYS, type JobGroupable } from './jobGroups';

// "Now" is Fri 13 Nov 2026, 10:00 local, so the day boundaries do not depend on when the suite runs.
const NOW = new Date(2026, 10, 13, 10, 0, 0);
const daysAgo = (days: number, hour = 9): string => new Date(2026, 10, 13 - days, hour, 0, 0).toISOString();

function job(id: string, status: string, createdAt: string): JobGroupable {
  return { id, status, createdAt };
}

describe('shortJobId', () => {
  it('is the first 8 characters of the id, the same text the URL starts with', () => {
    expect(shortJobId('129e4ca3-8973-4887-b4e9-d7c16dbb7fae')).toBe('129e4ca3');
    expect(shortJobId('abc')).toBe('abc');
  });
});

describe('isStaleJob', () => {
  it('marks only a job still awaiting review that is older than the limit', () => {
    expect(isStaleJob(job('a', 'diff_ready', daysAgo(STALE_AFTER_DAYS + 1)), NOW)).toBe(true);
    expect(isStaleJob(job('b', 'diff_ready', daysAgo(1)), NOW)).toBe(false);
    expect(isStaleJob(job('c', 'succeeded', daysAgo(30)), NOW)).toBe(false);
    expect(isStaleJob(job('d', 'failed', daysAgo(30)), NOW)).toBe(false);
  });

  it('treats a missing or unparsable date as not stale rather than guessing', () => {
    expect(isStaleJob(job('a', 'diff_ready', 'not a date'), NOW)).toBe(false);
  });
});

describe('groupJobs', () => {
  it('puts fresh Diff ready and fresh Failed jobs first, as "Needs you"', () => {
    const groups = groupJobs(
      [
        job('done', 'succeeded', daysAgo(0)),
        job('review', 'diff_ready', daysAgo(0)),
        job('failed', 'failed', daysAgo(1)),
        job('rejected', 'rejected', daysAgo(0)),
      ],
      NOW,
    );
    expect(groups[0].id).toBe('needs_you');
    expect(groups[0].jobs.map((j) => j.id)).toEqual(['review', 'failed']);
  });

  it('leaves a stale Diff ready job out of "Needs you" and puts it in its day group', () => {
    const groups = groupJobs([job('old', 'diff_ready', daysAgo(14)), job('new', 'diff_ready', daysAgo(0))], NOW);
    expect(groups.map((g) => g.id)).toEqual(['needs_you', 'earlier']);
    expect(groups[0].jobs.map((j) => j.id)).toEqual(['new']);
    expect(groups[1].jobs.map((j) => j.id)).toEqual(['old']);
  });

  it('groups the rest by local day: Today, Yesterday, This week, Earlier', () => {
    const groups = groupJobs(
      [
        job('e', 'succeeded', daysAgo(20)),
        job('w', 'rejected', daysAgo(4)),
        job('y', 'succeeded', daysAgo(1)),
        job('t', 'succeeded', daysAgo(0, 8)),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.id, g.jobs.map((j) => j.id)])).toEqual([
      ['today', ['t']],
      ['yesterday', ['y']],
      ['this_week', ['w']],
      ['earlier', ['e']],
    ]);
  });

  it('drops empty groups, and sorts each group newest first without changing the input', () => {
    const input = [job('a', 'succeeded', daysAgo(0, 7)), job('b', 'succeeded', daysAgo(0, 9))];
    const copy = input.map((j) => j.id);
    const groups = groupJobs(input, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].jobs.map((j) => j.id)).toEqual(['b', 'a']);
    expect(input.map((j) => j.id)).toEqual(copy);
  });

  it('keeps every job in exactly one group', () => {
    const jobs = Array.from({ length: 50 }, (_, i) =>
      job(`j${i}`, ['diff_ready', 'failed', 'succeeded', 'rejected'][i % 4], daysAgo(i % 25)),
    );
    const ids = groupJobs(jobs, NOW).flatMap((g) => g.jobs.map((j) => j.id));
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  });

  it('groups 20,000 jobs well under a second (one pass plus one sort)', () => {
    const jobs = Array.from({ length: 20000 }, (_, i) => job(`j${i}`, i % 3 === 0 ? 'diff_ready' : 'succeeded', daysAgo(i % 90)));
    const started = performance.now();
    const groups = groupJobs(jobs, NOW);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(groups.reduce((n, g) => n + g.jobs.length, 0)).toBe(20000);
  });
});
