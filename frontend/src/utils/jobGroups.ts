// How the Jobs list is grouped (DESIGN.md §11.1b): what needs the user first, then the rest by day. Pure, with `now` injected, so the
// day boundaries are testable and the page re-groups only when the list changes.
export const STALE_AFTER_DAYS = 7;

export interface JobGroupable {
  id: string;
  status: string;
  createdAt: string;
}

export type JobGroupId = 'running' | 'needs_you' | 'today' | 'yesterday' | 'this_week' | 'earlier';

export const JOB_GROUP_TITLES: Record<JobGroupId, string> = {
  running: 'Running now',
  needs_you: 'Needs you',
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  earlier: 'Earlier',
};

const GROUP_ORDER: JobGroupId[] = ['running', 'needs_you', 'today', 'yesterday', 'this_week', 'earlier'];
const DAY_MS = 24 * 60 * 60 * 1000;
// A pending or running job older than this has most likely lost its worker; it is asked about, not shown as live.
export const STALLED_AFTER_HOURS = 12;

// The first 8 characters of the job id: what the job's URL starts with, so a row can be matched to its page.
export function shortJobId(id: string): string {
  return id.slice(0, 8);
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// A job still awaiting review after the limit: the diff was computed against Azure DevOps as it was then. Only labelled, never
// archived or hidden by itself.
export function isStaleJob(job: JobGroupable, now: Date): boolean {
  if (job.status !== 'diff_ready') return false;
  const created = Date.parse(job.createdAt);
  return Number.isFinite(created) && now.getTime() - created > STALE_AFTER_DAYS * DAY_MS;
}

function dayGroupOf(createdAt: string, today: number): JobGroupId {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 'earlier';
  const daysBack = Math.round((today - startOfLocalDay(new Date(created))) / DAY_MS);
  if (daysBack <= 0) return 'today';
  if (daysBack === 1) return 'yesterday';
  if (daysBack < STALE_AFTER_DAYS) return 'this_week';
  return 'earlier';
}

// Pending or running for longer than a run can take. A write (status 'writing') is excluded: it is long by design and has its own progress.
export function isStalledJob(job: JobGroupable, now: Date): boolean {
  if (job.status !== 'pending' && job.status !== 'running') return false;
  const created = Date.parse(job.createdAt);
  return Number.isFinite(created) && now.getTime() - created > STALLED_AFTER_HOURS * 60 * 60 * 1000;
}

function needsYou(job: JobGroupable, now: Date): boolean {
  if (isStalledJob(job, now)) return true;
  if (job.status === 'failed') {
    const created = Date.parse(job.createdAt);
    return Number.isFinite(created) && now.getTime() - created <= STALE_AFTER_DAYS * DAY_MS;
  }
  return job.status === 'diff_ready' && !isStaleJob(job, now);
}

// A job that is waiting for a worker, running, or writing. Pinned above everything, whatever day it started: it is the job the user is
// waiting on, and it would otherwise sit under 17 proposals.
const RUNNING_STATUSES = new Set(['pending', 'running', 'writing']);

// "Running now" first, then "Needs you": a Diff ready or Failed job from the last week, or a run stalled for 12 hours. Everything else by local day, newest first. A stale job falls to
// its day group, so 60 old proposals do not bury today's. Each job is in exactly one group; empty groups are dropped.
export function groupJobs<T extends JobGroupable>(jobs: T[], now: Date): Array<{ id: JobGroupId; title: string; jobs: T[] }> {
  const today = startOfLocalDay(now);
  const buckets: Record<JobGroupId, T[]> = { running: [], needs_you: [], today: [], yesterday: [], this_week: [], earlier: [] };
  for (const job of jobs) {
    buckets[needsYou(job, now) && isStalledJob(job, now) ? 'needs_you' : RUNNING_STATUSES.has(job.status) ? 'running' : needsYou(job, now) ? 'needs_you' : dayGroupOf(job.createdAt, today)].push(job);
  }
  const time = (job: T): number => {
    const parsed = Date.parse(job.createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return GROUP_ORDER.filter((id) => buckets[id].length > 0).map((id) => ({
    id,
    title: JOB_GROUP_TITLES[id],
    jobs: [...buckets[id]].sort((a, b) => time(b) - time(a)),
  }));
}

// For each job that has an earlier job with the same file name (case aside), the short id of the nearest earlier one: "Re-run of 0c5d877e".
// The name is the only link the list has between two runs of one file. One sort and one pass.
export function rerunOf(jobs: ReadonlyArray<{ id: string; createdAt: string; originalFilename: string }>): Map<string, string> {
  const time = (createdAt: string): number => {
    const parsed = Date.parse(createdAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const oldestFirst = [...jobs].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const lastIdByName = new Map<string, string>();
  const out = new Map<string, string>();
  for (const job of oldestFirst) {
    const name = job.originalFilename.toLowerCase();
    const earlier = lastIdByName.get(name);
    if (earlier !== undefined) out.set(job.id, shortJobId(earlier));
    lastIdByName.set(name, job.id);
  }
  return out;
}
