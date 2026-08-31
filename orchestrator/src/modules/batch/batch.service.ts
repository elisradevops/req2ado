import { BadRequestException, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { ALLOWED_EXTENSIONS } from '../pipeline/jobs.controller';
import type { JobsService } from '../pipeline/jobs.service';
import { mapWithConcurrency } from '../pipeline/map-with-concurrency';
import { filterExcludedDiffEntries, summarizeDiffEntries, type DiffSummary } from '../pipeline/diff-summary';

// A batch file's externally-reported status: the underlying Job's own
// status once one exists and still resolves, 'deleted' if the Job was
// deleted (jobs are individually deletable, and Job.batchId/
// JobBatchFile.jobId are both deliberately relation-free), otherwise the
// JobBatchFile's own pre-submit status -- with the internal 'submitting'
// claim state reported as 'queued' (it's an implementation detail, not a
// user-facing state).
const RUNNING_STATUSES = ['pending', 'running', 'writing'];
const NOT_SUBMITTED_STATUSES = ['invalid', 'submit_failed'];
const REJECTED_STATUSES = ['rejected', 'cancelled'];

export interface BatchFileView {
  id: string;
  ordinal: number;
  filename: string;
  sizeBytes: number;
  status: string;
  jobId: string | null;
  error: string | null;
  queuePosition: number | null;
}

export interface BatchSummary extends DiffSummary {
  filesTotal: number;
  filesQueued: number;
  filesRunning: number;
  filesAwaitingReview: number;
  filesSucceeded: number;
  filesFailed: number;
  filesRejected: number;
  filesPending: number;
  itemsWritten: number;
  warningCount: number;
  warningKinds: Record<string, number>;
}

export interface BatchNote {
  kind: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface BatchDetail {
  id: string;
  // Internal-only -- BatchController strips this before returning to the
  // client (same "fetch internally for ownership, strip before response"
  // convention as JobsController.getById's own `userId: _userId` destructure).
  userId: string;
  createdAt: Date;
  areaPath: string;
  mode: string;
  state: string | null;
  iterationPath: string | null;
  model: string | null;
  files: BatchFileView[];
  summary: BatchSummary;
  notes: BatchNote[];
}

export interface BatchListEntry {
  id: string;
  createdAt: Date;
  areaPath: string;
  mode: string;
  filesTotal: number;
  filesSucceeded: number;
  filesFailed: number;
  filesPending: number;
}

// Bounded parallelism for pumpOnce()'s own submit() calls -- same
// `mapWithConcurrency` primitive confirm()/BackfillService already use.
// Fixed, not configurable: this bounds how many concurrent
// JobsService.submit() calls (Postgres writes + one BullMQ enqueue each)
// one pump tick makes, an orchestrator-process-local concern distinct from
// BATCH_SURVEY_CONCURRENCY (which bounds concurrent SURVEY *pipeline* runs,
// a real-LLM-backend concern).
const PUMP_SUBMIT_CONCURRENCY = 4;

// A pump tick claims at most this many files (BASELINE + throttled SURVEY
// combined) -- bounds one tick's own work; anything left over is picked up
// by the next tick (BATCH_PUMP_INTERVAL_MS later), never lost.
const MAX_SUBMISSIONS_PER_TICK = 50;

export interface SubmitBatchFileInput {
  buffer: Buffer;
  filename: string;
}

export interface SubmitBatchInput {
  userId: string;
  areaPath: string;
  mode: 'baseline' | 'survey';
  state?: string | null;
  iterationPath?: string | null;
  model?: string | null;
  files: SubmitBatchFileInput[];
}

export interface SubmitBatchResult {
  batchId: string;
  filesAccepted: number;
  filesRejected: number;
}

interface ValidatedBatchFile {
  ordinal: number;
  filename: string;
  sizeBytes: number;
  sourceHash: string;
  status: 'queued' | 'invalid';
  error: string | null;
  buffer: Buffer | null;
}

@Injectable()
export class BatchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobsService: JobsService,
    private readonly maxUploadSizeBytes: number,
    private readonly batchSurveyConcurrency: number,
    private readonly batchSubmitStuckMs: number,
  ) {}

  // Validates each file independently against the exact same rules
  // JobsController.submit() already enforces for a single file -- a
  // rejected file becomes status:'invalid' and never fails its siblings.
  // Only a batch with ZERO acceptable files is rejected outright (a
  // MAX_BATCH_FILES ceiling is enforced by BatchController before this is
  // ever called, not repeated here).
  private validateFiles(files: SubmitBatchFileInput[]): ValidatedBatchFile[] {
    return files.map((file, ordinal) => {
      const sizeBytes = file.buffer.length;
      const sourceHash = createHash('sha256').update(file.buffer).digest('hex');
      const dotIndex = file.filename.lastIndexOf('.');
      const ext = dotIndex >= 0 ? file.filename.slice(dotIndex).toLowerCase() : '';
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return { ordinal, filename: file.filename, sizeBytes, sourceHash, status: 'invalid', error: `unsupported file type: ${ext}`, buffer: null };
      }
      if (sizeBytes > this.maxUploadSizeBytes) {
        return {
          ordinal,
          filename: file.filename,
          sizeBytes,
          sourceHash,
          status: 'invalid',
          error: `file exceeds the ${Math.round(this.maxUploadSizeBytes / 1024 / 1024)}MB upload limit`,
          buffer: null,
        };
      }
      return { ordinal, filename: file.filename, sizeBytes, sourceHash, status: 'queued', error: null, buffer: file.buffer };
    });
  }

  async submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
    const validated = this.validateFiles(input.files);
    const filesAccepted = validated.filter((f) => f.status === 'queued').length;
    const filesRejected = validated.length - filesAccepted;
    if (filesAccepted === 0) {
      throw new BadRequestException('no acceptable files in this batch (every file was rejected)');
    }

    // Interactive transaction (not the array form): each JobBatchFileBlob
    // insert needs its own JobBatchFile's real generated id, which doesn't
    // exist until that create() resolves.
    const batchId = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.jobBatch.create({
        data: {
          userId: input.userId,
          areaPath: input.areaPath,
          mode: input.mode,
          state: input.state ?? null,
          iterationPath: input.iterationPath ?? null,
          model: input.model ?? null,
        },
      });
      for (const file of validated) {
        const batchFile = await tx.jobBatchFile.create({
          data: {
            batchId: batch.id,
            ordinal: file.ordinal,
            filename: file.filename,
            sizeBytes: file.sizeBytes,
            sourceHash: file.sourceHash,
            status: file.status,
            error: file.error,
          },
        });
        if (file.buffer) {
          await tx.jobBatchFileBlob.create({ data: { batchFileId: batchFile.id, bytes: file.buffer } });
        }
      }
      return batch.id;
    });

    // Submits as many queued files as there's room for right now -- a
    // BASELINE batch is typically fully enqueued before this call returns;
    // a SURVEY batch beyond the throttle cap leaves the rest 'queued' for
    // BatchPumpService's own interval to pick up.
    await this.pumpOnce();

    return { batchId, filesAccepted, filesRejected };
  }

  // Shared by getBatch/listBatches: a file's user-facing status is the
  // underlying Job's own status once one exists (or 'deleted' if that Job
  // no longer resolves -- jobs are individually deletable and
  // relation-free by design), otherwise the file's own pre-submit status
  // with the internal 'submitting' claim reported as 'queued'.
  private externalStatusOf(file: { jobId: string | null; status: string }, jobStatusById: Map<string, string>): string {
    if (file.jobId) {
      return jobStatusById.get(file.jobId) ?? 'deleted';
    }
    return file.status === 'submitting' ? 'queued' : file.status;
  }

  async getBatch(batchId: string): Promise<BatchDetail | null> {
    const batch = await this.prisma.jobBatch.findUnique({
      where: { id: batchId },
      include: { files: { orderBy: { ordinal: 'asc' } } },
    });
    if (!batch) return null;

    const jobIds = batch.files.map((f) => f.jobId).filter((id): id is string => id !== null);
    const jobs =
      jobIds.length > 0
        ? await this.prisma.job.findMany({
            where: { id: { in: jobIds } },
            select: {
              id: true,
              status: true,
              dryRunDiff: true,
              warnings: true,
              _count: { select: { createdItemMappings: true } },
            },
          })
        : [];
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const jobStatusById = new Map(jobs.map((j) => [j.id, j.status]));

    const queuedOrdinalsAscending = batch.files
      .filter((f) => this.externalStatusOf(f, jobStatusById) === 'queued')
      .map((f) => f.ordinal)
      .sort((a, b) => a - b);

    const files: BatchFileView[] = batch.files.map((f) => {
      const status = this.externalStatusOf(f, jobStatusById);
      const queuePosition = status === 'queued' ? queuedOrdinalsAscending.indexOf(f.ordinal) + 1 : null;
      return { id: f.id, ordinal: f.ordinal, filename: f.filename, sizeBytes: f.sizeBytes, status, jobId: f.jobId, error: f.error, queuePosition };
    });

    const diffSummary = jobs.reduce<DiffSummary>((acc, job) => {
      const diff = (job.dryRunDiff as { action: string; type: string; localId: string; parentLocalId: string | null; excluded?: boolean; groundingScore?: number | null; qualityScore?: number | null }[] | null) ?? [];
      // Same exclusion rule as JobsService.getSummary() -- an excluded
      // entry (or one whose ancestor is excluded) never counts toward
      // this batch-level rollup either.
      const s = summarizeDiffEntries(filterExcludedDiffEntries(diff));
      return { created: acc.created + s.created, reused: acc.reused + s.reused, dedupSkipped: acc.dedupSkipped + s.dedupSkipped, flagged: acc.flagged + s.flagged };
    }, { created: 0, reused: 0, dedupSkipped: 0, flagged: 0 });

    const itemsWritten = jobs.reduce((sum, job) => sum + job._count.createdItemMappings, 0);

    let warningCount = 0;
    const warningKinds: Record<string, number> = {};
    for (const job of jobs) {
      const warnings = (job.warnings as unknown[] | null) ?? [];
      for (const w of warnings) {
        warningCount += 1;
        const kind = typeof w === 'object' && w !== null && 'kind' in w ? String((w as { kind: unknown }).kind) : 'legacy';
        warningKinds[kind] = (warningKinds[kind] ?? 0) + 1;
      }
    }

    const filesQueued = files.filter((f) => f.status === 'queued').length;
    const filesRunning = files.filter((f) => RUNNING_STATUSES.includes(f.status)).length;
    const filesAwaitingReview = files.filter((f) => f.status === 'diff_ready').length;
    const filesSucceeded = files.filter((f) => f.status === 'succeeded').length;
    const filesNotSubmitted = files.filter((f) => NOT_SUBMITTED_STATUSES.includes(f.status)).length;
    const filesFailed = filesNotSubmitted + files.filter((f) => f.status === 'failed').length;
    const filesRejected = files.filter((f) => REJECTED_STATUSES.includes(f.status)).length;

    const summary: BatchSummary = {
      filesTotal: files.length,
      filesQueued,
      filesRunning,
      filesAwaitingReview,
      filesSucceeded,
      filesFailed,
      filesRejected,
      filesPending: filesQueued + filesRunning,
      ...diffSummary,
      itemsWritten,
      warningCount,
      warningKinds,
    };

    const notes: BatchNote[] = [
      {
        kind: 'cross_file_dedup_deferred',
        severity: 'info',
        message:
          "Duplicate detection compares a file against work items that already exist in Azure DevOps. Two files in this batch that are both still awaiting review are not compared against each other until one of them is confirmed.",
      },
    ];
    const hashCounts = new Map<string, number>();
    for (const f of batch.files) {
      if (f.status === 'invalid') continue;
      hashCounts.set(f.sourceHash, (hashCounts.get(f.sourceHash) ?? 0) + 1);
    }
    if ([...hashCounts.values()].some((count) => count > 1)) {
      notes.push({
        kind: 'identical_file_content',
        severity: 'warning',
        message: 'Two or more files in this batch have byte-identical content -- confirming more than one will reuse the same Azure DevOps items, not create separate ones.',
      });
    }
    if (batch.mode === 'survey' && filesQueued > 0) {
      notes.push({
        kind: 'survey_throttled',
        severity: 'info',
        message: `This deployment runs at most ${this.batchSurveyConcurrency} SURVEY file(s) from a batch at a time; the remaining queued file(s) will start automatically as slots free up.`,
      });
    }
    if (filesNotSubmitted > 0) {
      notes.push({
        kind: 'files_not_submitted',
        severity: 'warning',
        message: `${filesNotSubmitted} file(s) in this batch could not be submitted for processing -- see each file's own error.`,
      });
    }

    return {
      id: batch.id,
      userId: batch.userId,
      createdAt: batch.createdAt,
      areaPath: batch.areaPath,
      mode: batch.mode,
      state: batch.state,
      iterationPath: batch.iterationPath,
      model: batch.model,
      files,
      summary,
      notes,
    };
  }

  // Two queries total regardless of batch/file count (batches, then every
  // resolved Job's status in one IN query) -- deliberately not N+1, since
  // JobBatchFile.jobId is relation-free and can't be resolved via a nested
  // Prisma include.
  async listBatches(userId: string): Promise<BatchListEntry[]> {
    const batches = await this.prisma.jobBatch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { files: true },
    });
    if (batches.length === 0) return [];

    const allJobIds = batches.flatMap((b) => b.files.map((f) => f.jobId).filter((id): id is string => id !== null));
    const jobs =
      allJobIds.length > 0 ? await this.prisma.job.findMany({ where: { id: { in: allJobIds } }, select: { id: true, status: true } }) : [];
    const jobStatusById = new Map(jobs.map((j) => [j.id, j.status]));

    return batches.map((batch) => {
      const statuses = batch.files.map((f) => this.externalStatusOf(f, jobStatusById));
      const filesQueued = statuses.filter((s) => s === 'queued').length;
      const filesRunning = statuses.filter((s) => RUNNING_STATUSES.includes(s)).length;
      const filesNotSubmitted = statuses.filter((s) => NOT_SUBMITTED_STATUSES.includes(s)).length;
      return {
        id: batch.id,
        createdAt: batch.createdAt,
        areaPath: batch.areaPath,
        mode: batch.mode,
        filesTotal: batch.files.length,
        filesSucceeded: statuses.filter((s) => s === 'succeeded').length,
        filesFailed: filesNotSubmitted + statuses.filter((s) => s === 'failed').length,
        filesPending: filesQueued + filesRunning,
      };
    });
  }

  // Stops enqueueing the REST of a batch -- never touches a file already
  // submitted/submitting/settled. Touches no Job, no ADO, no queue.
  async cancelQueued(batchId: string): Promise<{ cancelled: number }> {
    const result = await this.prisma.jobBatchFile.updateMany({
      where: { batchId, status: 'queued' },
      data: { status: 'cancelled' },
    });
    return { cancelled: result.count };
  }

  // The whole concurrency answer for batch-originated SURVEY jobs, and the
  // mechanism that actually submits any queued file (BASELINE or SURVEY) as
  // a real Job. Pure logic, no timer -- BatchPumpService below is the only
  // thing that calls this on an interval; specs call it directly.
  //
  // Never throws: a bad tick must not crash the orchestrator process, and
  // because every decision here is recomputed fresh from the database on
  // each call, a tick that fails partway through self-heals on the very
  // next call with no special recovery logic needed.
  async pumpOnce(): Promise<{ submitted: number; failed: number }> {
    try {
      return await this.pumpOnceInner();
    } catch (error) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error('BatchService.pumpOnce: tick failed, will retry next interval:', error);
      return { submitted: 0, failed: 0 };
    }
  }

  private async pumpOnceInner(): Promise<{ submitted: number; failed: number }> {
    // Reclaim any file stuck in 'submitting' (claimed, then the process
    // died before JobsService.submit() finished) back to 'queued' so it
    // gets picked up again below, instead of being lost forever.
    const stuckCutoff = new Date(Date.now() - this.batchSubmitStuckMs);
    await this.prisma.jobBatchFile.updateMany({
      where: { status: 'submitting', claimedAt: { lt: stuckCutoff } },
      data: { status: 'queued', claimedAt: null },
    });

    // The scarce resource this throttles -- one real LLM generation slot in
    // this deployment's backend -- is GLOBAL, not per-batch, so the count is
    // too. diff_ready/writing are deliberately excluded: they mean
    // "awaiting a human" or "doing ADO round-trips," neither of which holds
    // the LLM slot this cap actually protects.
    const activeSurvey = await this.prisma.job.count({
      where: { batchId: { not: null }, mode: 'survey', status: { in: ['pending', 'running'] } },
    });
    const surveySlots = Math.max(0, this.batchSurveyConcurrency - activeSurvey);

    const queuedFiles = await this.prisma.jobBatchFile.findMany({
      where: { status: 'queued' },
      orderBy: [{ createdAt: 'asc' }, { ordinal: 'asc' }],
      include: { batch: true },
      take: MAX_SUBMISSIONS_PER_TICK * 4, // over-fetch; the mode split below may skip some SURVEY rows
    });

    const selected: (typeof queuedFiles)[number][] = [];
    let surveySlotsRemaining = surveySlots;
    for (const file of queuedFiles) {
      if (selected.length >= MAX_SUBMISSIONS_PER_TICK) break;
      if (file.batch.mode === 'survey') {
        if (surveySlotsRemaining <= 0) continue;
        surveySlotsRemaining -= 1;
      }
      selected.push(file);
    }

    if (selected.length === 0) {
      return { submitted: 0, failed: 0 };
    }

    const results = await mapWithConcurrency(selected, PUMP_SUBMIT_CONCURRENCY, async (file) => {
      // Optimistic claim: skip this file entirely if another tick (or, in a
      // multi-replica deployment, another process) already claimed it
      // between the findMany above and now -- zero additional lock
      // infrastructure needed.
      const claim = await this.prisma.jobBatchFile.updateMany({
        where: { id: file.id, status: 'queued' },
        data: { status: 'submitting', claimedAt: new Date() },
      });
      if (claim.count === 0) return 'skipped' as const;

      try {
        const blob = await this.prisma.jobBatchFileBlob.findUnique({ where: { batchFileId: file.id } });
        if (!blob) {
          throw new Error('batch file blob missing (already submitted or never stored)');
        }
        const { jobId } = await this.jobsService.submit({
          areaPath: file.batch.areaPath,
          userId: file.batch.userId,
          mode: file.batch.mode as 'baseline' | 'survey',
          fileBuffer: Buffer.from(blob.bytes),
          filename: file.filename,
          sourceHash: file.sourceHash,
          state: file.batch.state ?? undefined,
          iterationPath: file.batch.iterationPath,
          model: file.batch.model ?? undefined,
          batchId: file.batchId,
        });
        await this.prisma.$transaction([
          this.prisma.jobBatchFile.update({
            where: { id: file.id },
            data: { status: 'submitted', jobId, submittedAt: new Date() },
          }),
          this.prisma.jobBatchFileBlob.delete({ where: { batchFileId: file.id } }),
          this.prisma.auditEntry.create({
            data: {
              jobId,
              message: `Submitted from batch ${file.batchId} (file ${file.ordinal + 1} of the batch)`,
            },
          }),
        ]);
        return 'submitted' as const;
      } catch (error) {
        await this.prisma.jobBatchFile.update({
          where: { id: file.id },
          data: {
            status: 'submit_failed',
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          },
        });
        return 'failed' as const;
      }
    });

    let submitted = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === 'submitted') submitted += 1;
        else if (result.value === 'failed') failed += 1;
      }
      // 'rejected' shouldn't happen (the worker's own try/catch above
      // converts every failure into a resolved 'failed'), but if it ever
      // did, it's silently excluded from both counts rather than crashing
      // the tick -- the file's own row stays 'submitting' and gets reclaimed
      // by the stuck-claim sweep on a later tick.
    }
    return { submitted, failed };
  }
}
