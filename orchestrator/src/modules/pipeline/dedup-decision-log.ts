import type { PrismaClient } from '@prisma/client';

// Why an item was (or was nearly) skipped as a duplicate, kept for a while after the job is gone (see DedupDecisionLog in the Prisma schema).
// Plain functions that take the Prisma client, not a service: the worker, the review actions and the retention sweep each need one of them,
// and none of them should have to change its constructor for it. Every write is best-effort: a failure here is logged and never fails a job
// or a review action.

// The default the duplicate check itself uses when a job runs without a threshold of its own.
const DEFAULT_THRESHOLD = 0.9;
// One description can be pages long; the log only needs enough of it to see why two items matched.
export const DEDUP_LOG_MAX_TEXT_CHARS = 2000;
// A large document can hold hundreds of close matches; the closest ones tell the story.
export const DEDUP_LOG_MAX_ROWS_PER_JOB = 500;
const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;

export interface DedupCheckObservation {
  localId: string;
  itemType: string;
  areaPath: string;
  title: string;
  text: string;
  isDuplicate: boolean;
  matchedItemId: string | null;
  matchedText: string | null;
  similarity: number | null;
  judgeVerdict: string | null;
}

export interface DedupDecisionRow {
  jobId: string;
  localId: string;
  itemType: string;
  areaPath: string;
  scope: string;
  candidateTitle: string;
  candidateText: string;
  matchedAdoId: number | null;
  matchedText: string | null;
  similarity: number;
  threshold: number | null;
  judgeVerdict: string | null;
  decision: 'skipped' | 'not_skipped';
}

export type DedupReviewerOutcome = 'kept_skipped' | 'created_anyway';

const cut = (text: string | null): string | null => (text === null ? null : text.slice(0, DEDUP_LOG_MAX_TEXT_CHARS));

/** Which of a job's checks are worth keeping: those whose closest match scored at or above the threshold (skipped, or not confirmed). */
export function selectRowsToLog(jobId: string, scope: string, threshold: number | undefined, observations: DedupCheckObservation[]): DedupDecisionRow[] {
  const floor = threshold ?? DEFAULT_THRESHOLD;
  const rows: DedupDecisionRow[] = [];
  for (const o of observations) {
    if (o.similarity === null || !Number.isFinite(o.similarity) || o.similarity < floor) continue;
    const matched = o.matchedItemId === null ? NaN : Number(o.matchedItemId);
    rows.push({
      jobId,
      localId: o.localId,
      itemType: o.itemType,
      areaPath: o.areaPath,
      scope,
      candidateTitle: o.title.slice(0, DEDUP_LOG_MAX_TEXT_CHARS),
      candidateText: o.text.slice(0, DEDUP_LOG_MAX_TEXT_CHARS),
      matchedAdoId: Number.isFinite(matched) ? matched : null,
      matchedText: cut(o.matchedText),
      similarity: o.similarity,
      threshold: threshold ?? null,
      judgeVerdict: o.judgeVerdict,
      decision: o.isDuplicate ? 'skipped' : 'not_skipped',
    });
  }
  return rows.sort((a, b) => b.similarity - a.similarity).slice(0, DEDUP_LOG_MAX_ROWS_PER_JOB);
}

export async function recordDecisions(prisma: Pick<PrismaClient, 'dedupDecisionLog'>, rows: DedupDecisionRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await prisma.dedupDecisionLog.createMany({ data: rows });
  } catch (error) {
    // eslint-disable-next-line no-console -- best-effort: the log must never fail a job
    console.error(`Could not write ${rows.length} duplicate decision(s) to the decision log:`, error);
  }
}

/** Says what the reviewer did with the skips of one job: left alone and confirmed, created anyway, or the choice undone. */
export async function setReviewerOutcomes(
  prisma: Pick<PrismaClient, 'dedupDecisionLog'>,
  jobId: string,
  outcomes: { keptSkipped?: string[]; createdAnyway?: string[]; undone?: string[] },
): Promise<void> {
  const groups: { localIds: string[] | undefined; data: { reviewerOutcome: DedupReviewerOutcome | null; reviewerAt: Date | null } }[] = [
    { localIds: outcomes.keptSkipped, data: { reviewerOutcome: 'kept_skipped', reviewerAt: new Date() } },
    { localIds: outcomes.createdAnyway, data: { reviewerOutcome: 'created_anyway', reviewerAt: new Date() } },
    { localIds: outcomes.undone, data: { reviewerOutcome: null, reviewerAt: null } },
  ];
  for (const { localIds, data } of groups) {
    if (!localIds || localIds.length === 0) continue;
    try {
      await prisma.dedupDecisionLog.updateMany({ where: { jobId, localId: { in: localIds }, decision: 'skipped' }, data });
    } catch (error) {
      // eslint-disable-next-line no-console -- best-effort: the log must never fail a review action
      console.error(`Could not record the reviewer's decision for job ${jobId} in the decision log:`, error);
    }
  }
}

export async function deleteDecisionsOlderThan(prisma: Pick<PrismaClient, 'dedupDecisionLog'>, cutoff: Date): Promise<number> {
  const removed = await prisma.dedupDecisionLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return removed.count;
}

export interface DecisionQuery {
  since?: Date;
  until?: Date;
  jobId?: string;
  // 'undecided' = the reviewer has not decided yet.
  outcome?: DedupReviewerOutcome | 'undecided';
  limit?: number;
}

export async function listDecisions(prisma: Pick<PrismaClient, 'dedupDecisionLog'>, query: DecisionQuery) {
  const take = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
  const createdAt = query.since || query.until ? { ...(query.since ? { gte: query.since } : {}), ...(query.until ? { lte: query.until } : {}) } : undefined;
  return prisma.dedupDecisionLog.findMany({
    where: {
      ...(createdAt ? { createdAt } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.outcome === 'undecided' ? { reviewerOutcome: null } : query.outcome ? { reviewerOutcome: query.outcome } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

const CSV_COLUMNS = [
  'id', 'jobId', 'localId', 'itemType', 'areaPath', 'scope', 'candidateTitle', 'candidateText', 'matchedAdoId', 'matchedText', 'similarity',
  'threshold', 'judgeVerdict', 'decision', 'reviewerOutcome', 'reviewerAt', 'createdAt',
] as const;

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv(rows: Record<(typeof CSV_COLUMNS)[number], unknown>[]): string {
  return [CSV_COLUMNS.join(','), ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(','))].join('\r\n');
}
