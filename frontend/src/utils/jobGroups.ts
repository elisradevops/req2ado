// How the Jobs list is grouped (DESIGN.md §11.1b): what needs the user first, then the rest by day. Pure, with `now` injected, so the
// day boundaries are testable and the page re-groups only when the list changes.
export const STALE_AFTER_DAYS = 7;

export interface JobGroupable {
  id: string;
  status: string;
  createdAt: string;
}

export type JobGroupId = 'needs_you' | 'today' | 'yesterday' | 'this_week' | 'earlier';

export const JOB_GROUP_TITLES: Record<JobGroupId, string> = {
  needs_you: 'Needs you',
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  earlier: 'Earlier',
};

const GROUP_ORDER: JobGroupId[] = ['needs_you', 'today', 'yesterday', 'this_week', 'earlier'];
const DAY_MS = 24 * 60 * 60 * 1000;

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

function needsYou(job: JobGroupable, now: Date): boolean {
  if (job.status === 'failed') {
    const created = Date.parse(job.createdAt);
    return Number.isFinite(created) && now.getTime() - created <= STALE_AFTER_DAYS * DAY_MS;
  }
  return job.status === 'diff_ready' && !isStaleJob(job, now);
}

// "Needs you" first: a Diff ready or Failed job from the last week. Everything else by local day, newest first. A stale job falls to
// its day group, so 60 old proposals do not bury today's. Each job is in exactly one group; empty groups are dropped.
export function groupJobs<T extends JobGroupable>(jobs: T[], now: Date): Array<{ id: JobGroupId; title: string; jobs: T[] }> {
  const today = startOfLocalDay(now);
  const buckets: Record<JobGroupId, T[]> = { needs_you: [], today: [], yesterday: [], this_week: [], earlier: [] };
  for (const job of jobs) {
    buckets[needsYou(job, now) ? 'needs_you' : dayGroupOf(job.createdAt, today)].push(job);
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
