import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import type { McpClient } from './mcp.client';
import { IngestionHttpError, type IngestionHttpClient } from './ingestion-http.client';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { DryRunDiffEntry, WarningRecord } from '../writeback/dry-run.service';
import { mapWithConcurrency, type SettledResult } from './map-with-concurrency';
import { DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES } from '../../config/customer-id-fields';
import { normalizeAdoStoredHtml, toAdoDescriptionHtml } from './description-html';
import type { JobEventsPublisher } from './job-events.publisher';

export interface SubmitJobInput {
  areaPath: string;
  // The submitting user's stable ADO identity -- the Knowledge Base scope
  // key ingestion's /level uses for KB grounding, kept separate from
  // areaPath (ADO write-back destination + idempotency key only). Nullable:
  // KB grounding simply stays off for a job with no resolved identity.
  userId: string | null;
  customerId: string | null;
  mode: 'baseline' | 'survey';
  // True when this job ingests a follow-up document against requirements
  // already ingested under the same area path -- gates whether
  // pipeline.worker.ts runs the dedup-similarity check (see Job.followUp's
  // own schema.prisma doc comment). Defaults to false in submit() below,
  // matching pre-follow-up-mode behavior only insofar as dedup previously
  // ran unconditionally on every job -- see pipeline.worker.ts for the
  // actual behavior change.
  followUp?: boolean;
  fileBuffer: Buffer;
  filename: string;
  sourceHash: string;
  state?: string;
  iterationPath?: string | null;
  // Per-job LLM model OVERRIDE (SURVEY only) -- distinct from Job.model
  // (schema.prisma), which the worker persists as the EFFECTIVE model
  // (this override, or the orchestrator's configured default if unset).
  // This field is passed straight through to the BullMQ payload, never
  // read back off the Job row by submit() itself; resubmit() below reads
  // the persisted Job.model (the effective model of the original run) and
  // passes it back in here as a real override, so a resubmit pins to what
  // actually ran, not to whatever today's config default happens to be.
  model?: string;
}

export interface JobSummary {
  id: string;
  mode: string;
  status: string;
  areaPath: string;
  originalFilename: string;
  itemCount: number;
  // Real ADO work items written by a successful confirm() -- distinct from
  // itemCount (the proposed dry-run diff length, which stays the same
  // whether the job was later confirmed, rejected, or is still pending).
  // Backed by CreatedItemMapping, one row per item actually created.
  createdItemCount: number;
  createdAt: Date;
}

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly queue: Queue;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mcpClient: McpClient,
    private readonly idempotencyService: IdempotencyService,
    private readonly ingestionClient: IngestionHttpClient,
    redisUrl: string,
    private readonly initialState: string = 'Proposed',
    private readonly writeConcurrency: number = 8,
    private readonly customerIdFieldCandidates: string[] = DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES,
    // Same cap as upload validation (JobsController's MAX_UPLOAD_SIZE_BYTES)
    // -- reused rather than inventing a second config knob. Gates retention
    // for resubmit, not acceptance: an upload larger than this still
    // processes normally, it just isn't retained (no JobSourceFile row).
    private readonly maxStoredSourceBytes: number = 25 * 1024 * 1024,
    // Optional and trailing (not required alongside prisma/ingestionClient
    // above) so every existing test call site constructing JobsService
    // directly with a short positional arg list keeps working unchanged --
    // onModuleInit() below tolerates its absence (skips the SSE publish
    // step, still updates Job.status/AuditEntry) since a unit test
    // exercising unrelated methods has no reason to also wire up Redis.
    private readonly jobEventsPublisher?: JobEventsPublisher,
  ) {
    this.queue = new Queue('req2ado-pipeline', { connection: { url: redisUrl } as any });
  }

  /**
   * Reconciles Job rows against BullMQ's actual queue state on orchestrator
   * boot. Job.status (Postgres) and the BullMQ queue (Redis) are two
   * separate stores with no automatic reconciliation between them --
   * confirmed live: a Redis restart (e.g. `docker-compose up --build`
   * recreating the redis container with no persistent volume) wipes every
   * in-flight BullMQ job while Postgres's Job rows survive untouched, so a
   * job whose worker no longer exists keeps reading 'pending'/'running'/
   * 'writing' forever -- indistinguishable from a real in-progress job
   * until someone notices it never moves. 'writing' (mid ADO write-back) is
   * included deliberately: same reasoning as cancel()'s own restriction
   * would normally exclude it, but a 'writing' job with NO queue entry at
   * all can't possibly still be writing -- that combination only happens
   * when the worker that owned it is already gone, not mid-write.
   *
   * Runs once at startup, not on a timer: this fixes the "stuck forever"
   * failure mode (a crash/restart that already happened before this
   * process started), not a live race against a currently-healthy worker.
   *
   * Fails soft: this is a startup enhancement, not a hard dependency for
   * the app to come up -- a transient DB/Redis hiccup at the exact moment
   * of boot must not crash the whole orchestrator process (confirmed real:
   * this broke several e2e suites that bootstrap the full AppModule
   * against no live Postgres/Redis at all before this fix added the
   * try/catch). Same "enhancement, never fails the caller" convention as
   * app.kb.retrieval.retrieve_context on the ingestion side.
   */
  async onModuleInit(): Promise<void> {
    try {
      const orphanCandidates = await this.prisma.job.findMany({
        where: { status: { in: ['pending', 'running', 'writing'] } },
      });
      for (const job of orphanCandidates) {
        const bullJob = await this.queue.getJob(job.id);
        if (bullJob) continue; // still tracked by a real queue entry, not orphaned
        await this.prisma.job.update({ where: { id: job.id }, data: { status: 'failed' } });
        await this.prisma.auditEntry.create({
          data: {
            jobId: job.id,
            message: `Job marked failed on startup: no matching queue entry found for a '${job.status}' job (worker/queue restarted mid-run)`,
          },
        });
        await this.jobEventsPublisher?.publish(job.id, 'failed');
      }
    } catch (error) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error('JobsService.onModuleInit: orphaned-job reconciliation failed, continuing startup:', error);
    }
  }

  /**
   * Previously nothing ever closed this.queue's underlying ioredis
   * connection -- its open socket kept the Node event loop alive
   * indefinitely, so app.enableShutdownHooks() called app.close() on
   * SIGTERM but the process itself never actually exited (found live:
   * still 'running' 10+ seconds after SIGTERM against a real container).
   */
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  async submit(input: SubmitJobInput): Promise<{ jobId: string }> {
    const job = await this.prisma.job.create({
      data: {
        mode: input.mode,
        status: 'pending',
        sourceHash: input.sourceHash,
        areaPath: input.areaPath,
        userId: input.userId,
        followUp: input.followUp ?? false,
        state: input.state ?? this.initialState,
        iterationPath: input.iterationPath ?? null,
        customerId: input.customerId,
        originalFilename: input.filename,
      },
    });
    // BullMQ persists job data as JSON in Redis. JSON.stringify(Buffer)
    // produces {type:'Buffer', data:[...]}, which is NOT a Buffer instance
    // once read back on the worker side — base64-encoding here and decoding
    // in pipeline-worker.main.ts round-trips the exact bytes through JSON
    // safely. Found via the golden E2E script: every real upload was
    // silently producing an empty WorkItemTree with no error surfaced.
    // jobId option: makes BullMQ's own internal job id equal to our Prisma
    // Job.id, so cancel() below can look it up directly via queue.getJob(id)
    // instead of scanning for a data.id match. Previously omitted -- BullMQ
    // auto-assigned an unrelated internal id, which cancel() has no use for.
    await this.queue.add(
      'ingest-and-level',
      {
        id: job.id,
        areaPath: input.areaPath,
        userId: input.userId,
        customerId: input.customerId,
        mode: input.mode,
        followUp: input.followUp ?? false,
        fileBufferBase64: input.fileBuffer.toString('base64'),
        filename: input.filename,
        ...(input.model ? { model: input.model } : {}),
      },
      { jobId: job.id },
    );
    await this.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Job submitted: ${input.filename}, areaPath=${input.areaPath}` },
    });
    // Retention for resubmit() below -- best-effort: a failure here must
    // never fail the job submission itself, it only means this particular
    // job won't be resubmit-able later (the same degraded state as an
    // upload over maxStoredSourceBytes, or one ingested before this existed).
    if (input.fileBuffer.length <= this.maxStoredSourceBytes) {
      try {
        await this.prisma.jobSourceFile.create({ data: { jobId: job.id, bytes: input.fileBuffer } });
      } catch {
        // Swallowed deliberately -- see comment above.
      }
    }
    return { jobId: job.id };
  }

  // Re-runs a job's ORIGINAL upload under a brand-new Job row (never
  // mutates the source job) -- sourceHash is unchanged, so IdempotencyMapping
  // (keyed on sourceHash+customerId+areaPath) correctly REUSES the same ADO
  // items on confirm() rather than duplicating them, exactly as it does for
  // any other duplicate-content submission. If the caller wants genuinely
  // NEW items, they must change areaPath (a real product decision, not
  // something this method second-guesses).
  async resubmit(id: string): Promise<{ jobId: string }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    const sourceFile = await this.prisma.jobSourceFile.findUnique({ where: { jobId: id } });
    if (!sourceFile) {
      throw new NotFoundException(`Job ${id} has no retained source file to resubmit -- re-upload instead`);
    }
    return this.submit({
      areaPath: job.areaPath,
      userId: job.userId,
      customerId: job.customerId,
      mode: job.mode as 'baseline' | 'survey',
      followUp: job.followUp,
      fileBuffer: Buffer.from(sourceFile.bytes),
      filename: job.originalFilename,
      sourceHash: job.sourceHash,
      state: job.state,
      iterationPath: job.iterationPath,
      // Real bug, found while wiring Job.model (DESIGN.md §11.2.3.b): this
      // was previously omitted entirely, so a resubmit of a SURVEY job that
      // had a per-job model override silently reverted to the orchestrator's
      // default model. job.model here is the EFFECTIVE model the original
      // run used (worker-persisted, null for BASELINE and for any job that
      // predates this column) -- passing it forward as a real override
      // pins the resubmit to what actually ran, not to whatever today's
      // config default happens to be. "Resubmit" means "run this again,"
      // not "run this again under today's config."
      model: job.model ?? undefined,
    });
  }

  async getAuditTrail(id: string): Promise<{ id: string; message: string; createdAt: Date }[]> {
    return this.prisma.auditEntry.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  }

  // Proxies ingestion's debug-capture read -- best-effort, matching every
  // other enhancement in this codebase: a failure to REACH ingestion (down,
  // network) must not break the Audit tab that's already showing the job's
  // real AuditEntry rows; it just means this section shows empty instead.
  async getDebugCaptures(id: string): Promise<{ kind: string; identifier: string; content: string }[]> {
    try {
      return await this.ingestionClient.getDebugCaptures(id);
    } catch {
      return [];
    }
  }

  async getDedupSkips(
    id: string,
  ): Promise<{ id: string; localId: string; similarity: number; existingAdoId: number; createdAt: Date }[]> {
    return this.prisma.dedupSkipAudit.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  }

  // docs/architecture.md's "Customer ID Field Resolution": verified at
  // runtime against ado_discover_fields, never hardcoded to System.CustomerId
  // (System.* is ADO's reserved built-in namespace, not custom fields).
  // Candidate priority list is configurable (CUSTOMER_ID_FIELD_CANDIDATES),
  // defaulting to DocGen's real-world discovered naming conventions; each
  // candidate is verified present before use rather than trusted blind. If
  // none match on this work-item type, resolveCustomerIdField itself leaves
  // it off (traceability metadata, not a required field) -- but see the
  // System.Tags fallback in confirm()'s field assembly for the
  // non-type-gated backstop this enables (a type with no candidate field at
  // all, e.g. Epic/Feature in the tested org, still gets the customer ID
  // somewhere visible).
  private async resolveCustomerIdField(
    workItemType: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const availableFields = await this.mcpClient.discoverFields(workItemType, credential);
    return this.customerIdFieldCandidates.find((candidate) => availableFields.includes(candidate)) ?? null;
  }

  // Same runtime-verified resolution pattern as resolveCustomerIdField, for the
  // same reason: there is no persistent, addressable URL for an uploaded source
  // document in this system (no object storage / MinIO exists here), so an ADO
  // Hyperlink relation would point at a URL that doesn't resolve to anything.
  // Appending the reference into System.Description was also rejected -- that
  // would violate BASELINE's verbatim-fidelity contract (the description must
  // be exactly the source text, nothing appended). A dedicated field, set only
  // when the real org actually exposes one, is the only mechanism that is both
  // real and non-destructive. Left off (not a hard failure) when no candidate
  // field exists on that work-item type, exactly like Customer ID.
  private async resolveSourceRefField(
    workItemType: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const candidates = ['Custom.SourceReference', 'Custom.SourceDocument', 'Custom.TraceabilityRef'];
    const availableFields = await this.mcpClient.discoverFields(workItemType, credential);
    return candidates.find((candidate) => availableFields.includes(candidate)) ?? null;
  }

  private static formatSourceRef(sourceRef: {
    documentPath: string;
    startOffset: number;
    endOffset: number;
    page: number | null;
  }): string {
    const range = `${sourceRef.startOffset}-${sourceRef.endOffset}`;
    return sourceRef.page !== null
      ? `${sourceRef.documentPath}#page=${sourceRef.page}&offset=${range}`
      : `${sourceRef.documentPath}#offset=${range}`;
  }

  async getById(
    id: string,
  ): Promise<{
    id: string;
    status: string;
    mode: string;
    dryRunDiff: unknown;
    // Union with `string` is the back-compat seam: a job persisted before
    // the structured-warnings migration still has a literal string[] in its
    // Json? column -- see CollapsibleWarnings.tsx's normalizeWarning for
    // where that legacy shape gets reclassified into a WarningRecord.
    warnings: (WarningRecord | string)[];
    kbCitations: unknown;
    // {figureIndex, caption}[] -- see Job.figureDescriptions' schema.prisma
    // doc comment. Defaults to [] for a historical job (null column), same
    // convention as warnings above.
    figureDescriptions: { figureIndex: number; caption: string }[];
    // {tableId, caption}[] -- see Job.tableDescriptions' schema.prisma doc
    // comment. Defaults to [] for a historical job (null column), same
    // convention as figureDescriptions above.
    tableDescriptions: { tableId: string; caption: string }[];
    // Doc-wide figure/table ids the mapping stage judged decorative/
    // irrelevant, or that failed mapping (see Job.excludedFigureIds/
    // excludedTableIds' schema.prisma doc comment). Defaults to [] for a
    // historical job (null column) or a job predating this column, same
    // convention as warnings/figureDescriptions above.
    excludedFigureIds: string[];
    excludedTableIds: string[];
    createdAt: Date;
    areaPath: string;
    // Real Job columns (schema.prisma) that were fetched here all along
    // (findUnique with no select clause) but silently dropped by this
    // method's own narrow return object -- the frontend's DestinationBar
    // never had a value to render, showing "not set" and "—" regardless of
    // what a job was actually configured with.
    iterationPath: string | null;
    state: string;
    originalFilename: string;
    userId: string | null;
  } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      mode: job.mode,
      dryRunDiff: job.dryRunDiff,
      warnings: (job.warnings as (WarningRecord | string)[] | null) ?? [],
      kbCitations: job.kbCitations,
      figureDescriptions: (job.figureDescriptions as { figureIndex: number; caption: string }[] | null) ?? [],
      tableDescriptions: (job.tableDescriptions as { tableId: string; caption: string }[] | null) ?? [],
      excludedFigureIds: (job.excludedFigureIds as string[] | null) ?? [],
      excludedTableIds: (job.excludedTableIds as string[] | null) ?? [],
      createdAt: job.createdAt,
      areaPath: job.areaPath,
      iterationPath: job.iterationPath,
      state: job.state,
      originalFilename: job.originalFilename,
      userId: job.userId,
    };
  }

  // `userId` scopes the list to one caller's own jobs (ownership, matching
  // getById/every other per-job route below) -- undefined only in the
  // legacy pre-auth test suite's direct service calls, never in a real
  // request (the controller always resolves a session's userId first).
  async list(userId?: string): Promise<JobSummary[]> {
    const rows = await this.prisma.job.findMany({
      where: userId ? { userId } : {},
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        mode: true,
        status: true,
        areaPath: true,
        originalFilename: true,
        dryRunDiff: true,
        createdAt: true,
        _count: { select: { createdItemMappings: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      status: row.status,
      areaPath: row.areaPath,
      originalFilename: row.originalFilename,
      itemCount: Array.isArray(row.dryRunDiff) ? row.dryRunDiff.length : 0,
      createdItemCount: row._count.createdItemMappings,
      createdAt: row.createdAt,
    }));
  }

  async setDiffEntryExcluded(id: string, localId: string, excluded: boolean): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const index = diff.findIndex((entry) => entry.localId === localId);
    if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
    diff[index] = { ...diff[index], excluded };
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: diff as any } });
    return diff;
  }

  async editDiffEntry(id: string, localId: string, patch: { title?: string; description?: string }): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const index = diff.findIndex((entry) => entry.localId === localId);
    if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
    if (diff[index].action !== 'create') {
      throw new BadRequestException('only create entries can be edited');
    }
    // A patch key present with an explicit `undefined` value (as sent by the
    // controller for a caller who never mentioned that field) must not
    // overwrite the existing value — only apply keys the caller actually set.
    const definedPatch: { title?: string; description?: string } = {};
    if (patch.title !== undefined) definedPatch.title = patch.title;
    if (patch.description !== undefined) definedPatch.description = patch.description;
    // CR-7d rescore: quality scoring judges `description` text only (see
    // ingestion's _apply_quality_scores) -- a title-only edit changes
    // nothing the score was judged against, so only a real description
    // change marks the gauge stale. Only meaningful for an entry that was
    // actually scored before (qualityScore != null) -- an Epic/Feature or
    // never-scored Requirement has nothing to go stale.
    const descriptionChanged =
      definedPatch.description !== undefined && definedPatch.description !== diff[index].description;
    const staleness = descriptionChanged && diff[index].qualityScore != null ? { qualityStale: true } : {};
    diff[index] = { ...diff[index], ...definedPatch, ...staleness };
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: diff as any } });
    return diff;
  }

  // CR-7d rescore: re-judges ONE Requirement entry's CURRENT description
  // (post-edit) via ingestion's /score-item -- passes a forced rubric (see
  // resolveCategoryChecklist below) so a category-by-category delta is a
  // like-for-like comparison, not two different rubrics (see
  // IngestionHttpClient.scoreItem's own docstring). Throws (never silently
  // no-ops) on ingestion failure -- the caller (frontend) is responsible for
  // reverting its own optimistic "Re-checking" UI state back to Stale; this
  // method never writes a fabricated fresh score on failure.
  async rescoreDiffEntry(id: string, localId: string): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const index = diff.findIndex((entry) => entry.localId === localId);
    if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
    if (diff[index].action !== 'create') {
      throw new BadRequestException('only create entries can be rescored');
    }
    if (diff[index].type !== 'Requirement') {
      throw new BadRequestException('only Requirement entries can be rescored');
    }
    // DESIGN.md §11.4.4 flags persisting the document-wide category_checklist
    // (resolved once at ingestion from the highest-similarity KB citation,
    // llm_leveling.py:1708-1714) as a prerequisite -- without it, a rescore
    // could come back with different categoryScores KEYS, comparing two
    // different rubrics. A same-job sibling Requirement's own already-
    // persisted qualityCategoryScores achieves the identical guarantee
    // without a new column: _score_all_requirements resolves ONE checklist
    // per whole-document scoring pass and applies it to every Requirement
    // node in that pass, so any sibling that scored successfully carries the
    // SAME key set this job actually used. Falls back to this entry's own
    // keys first (the common case), then any scored sibling's (this entry's
    // own scoring entry failed to parse but the document-wide pass still
    // succeeded for others), then null (scoring failed for the whole
    // document -- nothing to reuse either way, same failure mode a
    // persisted-but-never-written column would also hit).
    const categoryChecklist = this.resolveCategoryChecklist(diff, index);
    let result: { qualityScore: number | null; qualityIssues: string[]; qualityCategoryScores: Record<string, number> | null };
    try {
      result = await this.ingestionClient.scoreItem(
        diff[index].description,
        categoryChecklist,
        job.userId ?? undefined,
        job.model ?? undefined,
      );
    } catch (err) {
      // Preserve the real reason (a real ingestion 5xx/timeout/etc.) instead
      // of letting a bare IngestionHttpError reach NestJS's default filter,
      // which would mask it behind a generic, undiagnosable 500 -- this
      // route is the first diff-mutation route with an inline external HTTP
      // dependency in its request/response cycle, so this gap was never hit
      // by editDiffEntry/addDiffEntry (pure DB/array operations, nothing to
      // fail this way).
      if (err instanceof IngestionHttpError) {
        throw new BadGatewayException(err.message);
      }
      throw err;
    }
    // A 200 response with quality_score: null is a REAL, documented outcome
    // (score_single_requirement_text returns it whenever the LLM response
    // is missing/malformed for this one item -- the exact same tolerant-
    // parse path the batch scorer already warns on) -- not a network
    // failure, but still a failed rescore from this entry's point of view.
    // Writing it through unconditionally would silently destroy the last
    // real score and clear qualityStale, directly violating DESIGN.md
    // §11.4.4: "a failed rescore must never launder a stale number into a
    // fresh-looking one." Throw instead so the caller's existing
    // catch-and-revert-to-Stale path (NodeDetailPanel.tsx's
    // handleRescoreClick) handles this exactly like any other failure --
    // the entry (and its qualityStale flag) stays untouched.
    if (result.qualityScore == null) {
      throw new BadGatewayException('Rescore did not return a usable score -- the item was left unchanged.');
    }
    // qualityCategoryChecklist (the org's own checklist citation text per
    // category, see ingestion's quality_category_checklist docstring,
    // app.workitem.model) is deliberately NOT overwritten here -- the
    // spread above carries the entry's EXISTING map through untouched.
    // ingestion's /score-item route has no access to the raw KB checklist
    // text at all (only category NAMES, via categoryChecklist above, reused
    // as this rescore's fixed rubric) so there is nothing fresher to write.
    // Reusing the old map is still correct, not stale: resolveCategoryChecklist
    // guarantees this rescore is judged against the SAME category key set,
    // so whichever keys already had a matched citation still do.
    diff[index] = {
      ...diff[index],
      qualityScore: result.qualityScore,
      qualityIssues: result.qualityIssues,
      qualityCategoryScores: result.qualityCategoryScores,
      qualityStale: false,
    };
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: diff as any } });
    return diff;
  }

  private resolveCategoryChecklist(diff: DryRunDiffEntry[], index: number): string[] | null {
    const own = diff[index].qualityCategoryScores;
    if (own) return Object.keys(own);
    const sibling = diff.find(
      (entry, i) => i !== index && entry.type === 'Requirement' && entry.qualityCategoryScores,
    );
    return sibling ? Object.keys(sibling.qualityCategoryScores as Record<string, number>) : null;
  }

  async addDiffEntry(
    id: string,
    input: { parentLocalId: string; type: string; title: string; description: string },
  ): Promise<DryRunDiffEntry[]> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const parentEntry = diff.find((entry) => entry.localId === input.parentLocalId);
    if (!parentEntry) throw new NotFoundException(`Diff entry ${input.parentLocalId} not found`);
    if (parentEntry.isManual) {
      throw new BadRequestException('cannot add a child under a manually-added entry');
    }
    if (job.mode === 'baseline') {
      if (input.type !== parentEntry.childType) {
        throw new BadRequestException(`type '${input.type}' does not match the required child type '${parentEntry.childType}'`);
      }
    } else {
      const validTypes = ['Epic', 'Feature', 'Requirement'];
      if (!validTypes.includes(input.type)) {
        throw new BadRequestException(`type must be one of ${validTypes.join(', ')}`);
      }
    }
    const sourceHash = createHash('sha256').update(input.description).digest('hex');
    const newEntry: DryRunDiffEntry = {
      localId: `manual-${diff.length}-${Date.now()}`,
      parentLocalId: input.parentLocalId,
      type: input.type,
      title: input.title,
      description: input.description,
      action: 'create',
      existingAdoId: null,
      similarity: null,
      sourceHash,
      customerId: null,
      tags: [],
      qualityScore: null,
      qualityIssues: [],
      childType: null,
      isManual: true,
    };
    const updated = [...diff, newEntry];
    await this.prisma.job.update({ where: { id }, data: { dryRunDiff: updated as any } });
    return updated;
  }

  // Mirrors frontend/src/pages/JobStatus.tsx's needsReview() thresholds --
  // duplicated (not imported) because frontend and orchestrator are separate
  // deployables with no shared package for these constants, same as that
  // file's own comment mirroring ingestion's llm_leveling thresholds.
  private static readonly LOW_GROUNDING_THRESHOLD = 0.2;
  private static readonly LOW_QUALITY_THRESHOLD = 50;

  private static isFlagged(entry: { groundingScore?: number | null; qualityScore?: number | null }): boolean {
    return (
      (entry.groundingScore != null && entry.groundingScore < JobsService.LOW_GROUNDING_THRESHOLD) ||
      (entry.qualityScore != null && entry.qualityScore < JobsService.LOW_QUALITY_THRESHOLD)
    );
  }

  async getSummary(id: string): Promise<{
    created: number;
    reused: number;
    dedupSkipped: number;
    flagged: number;
    // Union with `string` is the back-compat seam: a job persisted before
    // the structured-warnings migration still has a literal string[] in its
    // Json? column -- see CollapsibleWarnings.tsx's normalizeWarning for
    // where that legacy shape gets reclassified into a WarningRecord.
    warnings: (WarningRecord | string)[];
  } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    const diff = (job.dryRunDiff as { action: string; groundingScore?: number | null; qualityScore?: number | null }[] | null) ?? [];
    return {
      created: diff.filter((e) => e.action === 'create').length,
      reused: diff.filter((e) => e.action === 'reuse').length,
      dedupSkipped: diff.filter((e) => e.action === 'dedup_skip').length,
      flagged: diff.filter((e) => JobsService.isFlagged(e)).length,
      warnings: (job.warnings as (WarningRecord | string)[] | null) ?? [],
    };
  }

  // Post-write validation: reads back every work item this job actually
  // created (via CreatedItemMapping, the same P4b resume state confirm()
  // itself writes) and compares its real ADO fields/parent link against
  // what the dry-run diff expected. Closes a real gap: confirm() previously
  // wrote and moved on with zero verification that ADO's stored state
  // matches what was sent -- a silently-dropped/altered field (e.g. an ADO
  // field-length truncation, a picklist coercion) would never surface.
  // Read-only -- makes no ADO writes itself, only GETs via
  // getWorkItemsBatch.
  async validateCreatedTree(
    id: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<{
    valid: boolean;
    checkedCount: number;
    mismatches: { localId: string; adoWorkItemId: number; field: string; expected: string; actual: string }[];
  } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;

    const mappings = await this.prisma.createdItemMapping.findMany({ where: { jobId: id } });
    if (mappings.length === 0) {
      return { valid: true, checkedCount: 0, mismatches: [] };
    }

    const adoIdByLocalId = new Map(mappings.map((m) => [m.localId, m.adoWorkItemId]));
    const diff = (job.dryRunDiff as { localId: string; parentLocalId: string | null; title: string; description: string }[] | null) ?? [];
    const diffByLocalId = new Map(diff.map((entry) => [entry.localId, entry]));

    const items = await this.mcpClient.getWorkItemsBatch(
      mappings.map((m) => m.adoWorkItemId),
      credential,
    );
    const itemById = new Map(items.map((item) => [item.id, item]));

    const mismatches: { localId: string; adoWorkItemId: number; field: string; expected: string; actual: string }[] = [];
    for (const mapping of mappings) {
      const entry = diffByLocalId.get(mapping.localId);
      const item = itemById.get(mapping.adoWorkItemId);
      if (!entry) continue; // dryRunDiff no longer has this node -- nothing to compare against
      if (!item) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'existence', expected: 'work item exists in ADO', actual: 'not found',
        });
        continue;
      }
      if (item.fields['System.Title'] !== entry.title) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'System.Title', expected: entry.title, actual: item.fields['System.Title'] ?? '',
        });
      }
      // Compared against the SAME conversion the create call applies (see
      // toAdoDescriptionHtml's own doc comment) -- ADO actually stores the
      // converted HTML, not entry.description verbatim, so comparing raw
      // would false-positive a mismatch on every single audited item.
      // normalizeAdoStoredHtml additionally undoes ADO's OWN write-time
      // re-serialization (confirmed via a real round-trip spike, see
      // docs/superpowers/specs/2026-08-12-table-fidelity-design.md's Phase
      // 0 findings) -- without it, this comparison false-positived on
      // EVERY item, table or not (even a plain `<p>text</p>` description
      // came back as `<p>text </p>`).
      const expectedDescriptionHtml = toAdoDescriptionHtml(entry.description);
      const actualDescriptionHtml = normalizeAdoStoredHtml(item.fields['System.Description'] ?? '');
      if (actualDescriptionHtml !== expectedDescriptionHtml) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'System.Description', expected: expectedDescriptionHtml, actual: item.fields['System.Description'] ?? '',
        });
      }
      const expectedParentAdoId = entry.parentLocalId !== null ? (adoIdByLocalId.get(entry.parentLocalId) ?? null) : null;
      if (expectedParentAdoId !== item.parentId) {
        mismatches.push({
          localId: mapping.localId, adoWorkItemId: mapping.adoWorkItemId,
          field: 'parentId', expected: String(expectedParentAdoId), actual: String(item.parentId),
        });
      }
    }

    return { valid: mismatches.length === 0, checkedCount: mappings.length, mismatches };
  }

  /**
   * Cancels a job that's still queued or running -- 'writing' and beyond
   * are excluded (a confirmed write may already be partially applied to
   * real ADO, same reasoning as reject()'s own restriction), and
   * 'diff_ready' has its own dedicated Reject flow instead.
   *
   * If the BullMQ job hasn't been picked up yet (still 'waiting'/'delayed'),
   * this removes it outright -- clean, immediate cancellation, the worker
   * never runs at all. If it's already 'active' (the sandboxed processor is
   * mid pipeline.worker.ts run, most likely blocked on ingestion's /level
   * call for 15-40+ minutes), BullMQ has no mechanism to forcibly kill that
   * external HTTP call from here -- there is no cross-process abort channel
   * between this HTTP process and the worker's separate child process.
   * Flipping Job.status to 'cancelled' still has real effect: JobDetail's
   * SSE-driven UI reflects it immediately, and pipeline.worker.ts checks
   * this same status at its own checkpoints (see JobCancelledError) to stop
   * short of persisting a dry-run diff or emitting diff_ready once the
   * long call eventually resolves. Net effect: cancellation is immediate
   * if the job hasn't started, and takes effect at the next checkpoint
   * (not mid-call) if it has -- an honest limitation, not silently pretended
   * to be instant in every case.
   */
  // `reason` defaults to the pre-existing message -- every caller before
  // StaleJobWatchdogService existed omits it and gets byte-identical
  // behavior. The watchdog passes its own distinguishing message so an
  // automatic stall-cancellation never falsely reads as "by user".
  async cancel(id: string, reason: string = 'Job cancelled by user'): Promise<{ status: string }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    if (job.status !== 'pending' && job.status !== 'running') {
      throw new ConflictException(`Job ${id} cannot be cancelled from status '${job.status}'`);
    }
    const bullJob = await this.queue.getJob(id);
    if (bullJob) {
      const state = await bullJob.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
        await bullJob.remove();
      }
    }
    await this.prisma.job.update({ where: { id }, data: { status: 'cancelled' } });
    await this.prisma.auditEntry.create({ data: { jobId: id, message: reason } });
    return { status: 'cancelled' };
  }

  // Hard delete via an explicit transaction, not `onDelete: Cascade` on the
  // child relations -- a cascade can't reach ChatMessage (no FK relation at
  // all, only an index) and an explicit transaction covers all four rows
  // without a schema migration. IdempotencyMapping is deliberately NOT
  // touched here -- it's keyed by (sourceHash, customerId, areaPath), not
  // jobId, and is intentionally cross-job (see its own model comment); a
  // deleted job's prior ADO writes must stay idempotency-protected against a
  // future resubmit of the same source content.
  async delete(id: string): Promise<{ deleted: true }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    // 'pending'/'running'/'writing' must be cancelled (or left to finish)
    // first -- deleting a job mid-run/mid-write would orphan the still-
    // in-flight BullMQ job or interrupt a live ADO write with no recovery
    // path (unlike cancel(), which cooperatively stops the pipeline).
    if (job.status === 'pending' || job.status === 'running' || job.status === 'writing') {
      throw new ConflictException(`Job ${id} cannot be deleted while '${job.status}' -- cancel it first`);
    }
    await this.prisma.$transaction([
      this.prisma.chatMessage.deleteMany({ where: { jobId: id } }),
      this.prisma.createdItemMapping.deleteMany({ where: { jobId: id } }),
      this.prisma.dedupSkipAudit.deleteMany({ where: { jobId: id } }),
      this.prisma.auditEntry.deleteMany({ where: { jobId: id } }),
      this.prisma.jobSourceFile.deleteMany({ where: { jobId: id } }),
      this.prisma.jobFigureFile.deleteMany({ where: { jobId: id } }),
      // Real bug (user-reported): JobEvent has a required FK to Job with no
      // onDelete: Cascade (schema.prisma) -- every job that ever emitted a
      // narration event (i.e. every job that actually ran) has JobEvent
      // rows, so job.delete() below unconditionally failed with a foreign
      // key violation. This was the one relation missing from this list.
      this.prisma.jobEvent.deleteMany({ where: { jobId: id } }),
      // JobTraceLinkFailure has the same required, non-cascading FK to Job
      // as every other Job-child table here -- added alongside the model
      // itself so a job with a stuck trace-link failure can never hit the
      // same FK-violation bug JobEvent had above.
      this.prisma.jobTraceLinkFailure.deleteMany({ where: { jobId: id } }),
      this.prisma.job.delete({ where: { id } }),
    ]);
    return { deleted: true };
  }

  // Upsert, not create: ingestion's caption call is a normal HTTP POST with
  // the usual retry-on-timeout risk, and figureId (not filename) is the only
  // identity that matters here (see JobFigureFile's own model comment) --
  // a retried POST for the same figure must overwrite, never duplicate or
  // 500 on the @@unique([jobId, figureId]) constraint.
  async storeFigureFile(jobId: string, figureId: string, bytes: Buffer, mimeType: string): Promise<void> {
    await this.prisma.jobFigureFile.upsert({
      where: { jobId_figureId: { jobId, figureId } },
      create: { jobId, figureId, bytes, mimeType },
      update: { bytes, mimeType },
    });
  }

  // Browser-facing counterpart to storeFigureFile (GET :id/figures/:figureId
  // route) -- serves a stored figure's raw bytes back to an authenticated
  // review session so FigureDescriptions/NodeDetailPanel can render the
  // actual image instead of only the vision-model's text caption. Returns
  // null (not a thrown error) when the row doesn't exist: a figure already
  // attached to ADO (deleted on success, see attachFigureToAdo/confirm()'s
  // own attach phase) or never stored is a normal outcome here, not a
  // service-layer failure -- the controller decides the HTTP shape.
  async getFigureFile(jobId: string, figureId: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const figureFile = await this.prisma.jobFigureFile.findUnique({ where: { jobId_figureId: { jobId, figureId } } });
    if (!figureFile) return null;
    return { bytes: Buffer.from(figureFile.bytes), mimeType: figureFile.mimeType };
  }

  // Manual counterpart to confirm()'s automatic figure-attachment phase --
  // needed for two real gaps that phase alone can't cover: (1) it only ever
  // runs ONCE, at confirm() time, guarded on job.status === 'diff_ready' --
  // a job that's already 'succeeded' (including every job confirmed before
  // the DryRunDiffEntry.figureIds carry-through bug was fixed -- see that
  // field's own doc comment in dry-run.service.ts) can never re-enter
  // confirm() to pick up a figure it missed. (2) even going forward, a
  // single figure's attachment there is best-effort/silently-swallowed by
  // design (one bad upload must not revert an otherwise-successful
  // confirm), so there was previously no way to retry one specific
  // failure. Reuses the SAME mcpClient.uploadAttachment call and
  // delete-on-success bookkeeping confirm() already uses -- not a second
  // implementation of ADO attachment.
  //
  // Resolves the entry's real ADO id from whichever of the two sources
  // confirm()'s own adoIdByLocalId map draws from: existingAdoId directly
  // for a reuse/dedup_skip entry (known at diff time, before this job is
  // even confirmed), or CreatedItemMapping for a 'create' entry (only
  // resolvable once this job's confirm() has actually run).
  async attachFigureToAdo(
    jobId: string,
    localId: string,
    figureId: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<{ attached: true; adoId: number }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const entry = diff.find((e) => e.localId === localId);
    if (!entry) throw new NotFoundException(`Diff entry ${localId} not found in job ${jobId}`);

    let adoId: number | null = null;
    if ((entry.action === 'reuse' || entry.action === 'dedup_skip') && entry.existingAdoId !== null) {
      adoId = entry.existingAdoId;
    } else {
      const mapping = await this.prisma.createdItemMapping.findUnique({
        where: { jobId_localId: { jobId, localId } },
      });
      adoId = mapping?.adoWorkItemId ?? null;
    }
    if (adoId === null) {
      throw new BadRequestException(`Entry ${localId} has no resolved ADO work item id yet`);
    }

    const figureFile = await this.prisma.jobFigureFile.findUnique({ where: { jobId_figureId: { jobId, figureId } } });
    if (!figureFile) {
      throw new NotFoundException(`Figure ${figureId} not found for job ${jobId}`);
    }

    await this.mcpClient.uploadAttachment(
      adoId,
      `${figureId}.png`,
      Buffer.from(figureFile.bytes).toString('base64'),
      figureFile.mimeType,
      credential,
    );
    // Same delete-on-success bookkeeping as confirm()'s own attach phase --
    // a re-triggered manual attach after a prior success 404s via
    // getFigureFile/this same lookup instead of re-uploading a duplicate
    // attachment, and the row doesn't linger forever once its bytes have a
    // permanent home in ADO.
    await this.prisma.jobFigureFile.delete({ where: { id: figureFile.id } });
    return { attached: true, adoId };
  }

  // Manual retry counterpart to confirm()'s best-effort trace-link write
  // phase -- mirrors attachFigureToAdo above for exactly the same two gaps:
  // an already-'succeeded' job can never re-enter confirm() to retry a link
  // that failed, and a single failure there is silently swallowed by design
  // (Task 2b/2c). The JobTraceLinkFailure row stores the resolved ADO ids
  // denormalized, so no re-resolution against dryRunDiff/CreatedItemMapping
  // is needed here the way attachFigureToAdo needs it for adoId. A failure
  // here throws (this is an explicit user action, not a best-effort
  // background phase) rather than being swallowed and re-recorded.
  async retryTraceLinkWrite(
    jobId: string,
    failureId: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<{ written: true; sourceAdoId: number; targetAdoId: number }> {
    const failure = await this.prisma.jobTraceLinkFailure.findUnique({ where: { id: failureId } });
    if (!failure || failure.jobId !== jobId) {
      throw new NotFoundException(`Trace-link failure ${failureId} not found for job ${jobId}`);
    }

    await this.mcpClient.linkWorkItems(failure.sourceAdoId, failure.targetAdoId, failure.referenceName, credential);
    await this.prisma.jobTraceLinkFailure.delete({ where: { id: failure.id } });

    // Recompute the trace_link_write_failed warning: drop it if this was the
    // last outstanding failure, otherwise shrink its nodeIds/raw text to the
    // remaining set. Without this, a fully-recovered job would show a
    // permanently stale "N trace links failed" warning forever after every
    // one of them was successfully retried.
    const remaining = await this.prisma.jobTraceLinkFailure.findMany({ where: { jobId } });
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (job) {
      const existingWarnings = (job.warnings as (WarningRecord | string)[] | null) ?? [];
      const withoutTraceLinkWarning = existingWarnings.filter(
        (w) => typeof w === 'string' || w.kind !== 'trace_link_write_failed',
      );
      const updatedWarnings: (WarningRecord | string)[] =
        remaining.length > 0
          ? [
              ...withoutTraceLinkWarning,
              {
                kind: 'trace_link_write_failed',
                severity: 'pipeline_issue',
                nodeIds: Array.from(new Set(remaining.map((f) => f.sourceLocalId))),
                detail: {},
                raw: `${remaining.length} trace link${remaining.length === 1 ? '' : 's'} failed to write to Azure DevOps and can be retried from the node detail panel.`,
              } satisfies WarningRecord,
            ]
          : withoutTraceLinkWarning;
      await this.prisma.job.update({ where: { id: jobId }, data: { warnings: updatedWarnings as any } });
    }

    return { written: true, sourceAdoId: failure.sourceAdoId, targetAdoId: failure.targetAdoId };
  }

  // Rejecting is only meaningful from 'diff_ready' -- once writing/succeeded,
  // real ADO writes may already exist and a reject can't undo those
  // (P4b's CreatedItemMapping enables safe RESUME of a failed confirm, not
  // rollback/deletion of a job that succeeded or is mid-write).
  async reject(id: string): Promise<{ status: string }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job || job.status !== 'diff_ready') {
      throw new Error(`Job ${id} is not in a rejectable state`);
    }
    await this.prisma.job.update({ where: { id }, data: { status: 'rejected' } });
    await this.prisma.auditEntry.create({ data: { jobId: id, message: 'Job rejected: no work items written' } });
    return { status: 'rejected' };
  }

  async confirm(
    id: string,
    credential?: { orgUrl: string; pat: string },
    // Row-level deselect: when provided, only 'create' entries whose localId
    // is in this set are written -- everything else (reuse/dedup_skip
    // entries, which never trigger a create anyway) is unaffected. Omitted
    // entirely (not just empty) means "select all", matching the previous
    // all-or-nothing behavior byte-for-byte for every existing caller. This
    // is independent of, and additive with, the persistent `excluded` flag
    // set via setDiffEntryExcluded below -- either mechanism can drop a node.
    selectedLocalIds?: string[],
  ): Promise<{ status: string; createdCount: number }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job || job.status !== 'diff_ready') {
      throw new Error(`Job ${id} is not in a confirmable state`);
    }
    await this.prisma.job.update({ where: { id }, data: { status: 'writing' } });
    // Previously confirm() had no JobEventsPublisher at all -- structurally
    // incapable of publishing anything, and JobDetail.tsx had no render
    // branch for status === 'writing' either (contrast with the explicit
    // 'pending' branch), so a job mid real-ADO-write showed NOTHING in the
    // UI for however long the create/link/trace-link phases below took.
    await this.jobEventsPublisher?.publish(id, 'writing');

    // Each diff entry carries its own sourceHash/customerId (per-node content
    // hash), NOT job.sourceHash (a whole-file hash) — see DryRunDiffEntry's
    // doc comment for why recording at job-level granularity silently broke
    // re-run idempotency (found via the golden E2E script: job #2's re-run
    // always showed 'create' since the recorded key never matched the
    // per-node key diff() looks up by).
    const diff = job.dryRunDiff as {
      localId: string;
      parentLocalId: string | null;
      type: string;
      title: string;
      description: string;
      action: string;
      existingAdoId: number | null;
      sourceHash: string;
      customerId: string | null;
      // Carried through from ingestion (see DryRunDiffEntry). sourceRef is
      // written to ADO below (see resolveSourceRefField); tags feeds
      // System.Tags directly. Both optional/nullable: manually-added entries
      // (addDiffEntry) and older-shaped fixtures may omit either entirely.
      sourceRef?: { documentPath: string; startOffset: number; endOffset: number; page: number | null } | null;
      tags?: string[];
      excluded?: boolean;
      traceLinks?: {
        sourceLocalId: string;
        referenceName: string;
        targetKind: 'intraJob' | 'crossJob';
        targetLocalId?: string;
        targetCustomerId?: string;
        resolvedAdoId?: number;
        resolutionStatus: 'resolved' | 'unresolved' | 'pending';
      }[];
      // Carried through from ingestion (see DryRunTreeNode.figureIds) --
      // JobFigureFile rows this entry's created/resolved work item should
      // get as ADO attachments, see the attach phase near the end of this
      // method. Optional/nullable: older/mocked diff shapes predate this.
      figureIds?: string[];
      // Carried through from ingestion (see DryRunDiffEntry.tableIds/
      // uncaptionedFigureIds) -- not consumed anywhere in this method today,
      // but must still be declared on this inline type: omitting a field
      // here silently drops it on the `{...diff[index]}`-style rewrites this
      // file does elsewhere (same class of bug figureIds itself previously
      // hit, see DryRunDiffEntry.figureIds' own doc comment).
      tableIds?: string[];
      uncaptionedFigureIds?: string[];
    }[];

    // Excluding an entry excludes its whole subtree too, even if a descendant
    // itself isn't marked excluded — walk parentLocalId ancestry to find out.
    const diffById = new Map(diff.map((entry) => [entry.localId, entry] as const));
    function isExcluded(entry: (typeof diff)[number]): boolean {
      let current: typeof entry | undefined = entry;
      while (current) {
        if (current.excluded) return true;
        current = current.parentLocalId ? diffById.get(current.parentLocalId) : undefined;
      }
      return false;
    }

    // Resume support (P4b, previously "not yet built" -- see this method's
    // old catch-block comment): a durable local-id -> ADO-id mapping,
    // written immediately after each create/link succeeds (not batched at
    // the end), so a failure partway through THIS call, or a prior call
    // that already got partway through, leaves correct state for a safe
    // retry. Loaded once up front; `resumedAdoIdByLocalId`/
    // `alreadyLinkedLocalIds` reflect what was already durably written
    // before this call started.
    const existingMappings = await this.prisma.createdItemMapping.findMany({ where: { jobId: id } });
    const resumedAdoIdByLocalId = new Map(existingMappings.map((m) => [m.localId, m.adoWorkItemId]));
    const alreadyLinkedLocalIds = new Set(existingMappings.filter((m) => m.linked).map((m) => m.localId));

    // Tree order from ingestion (parents appear before children — see
    // tree_builder.py's stack-based construction) means a single left-to-right
    // pass is sufficient: every entry's parentLocalId, if non-null, already
    // has its ADO id in this map by the time we reach the child.
    const adoIdByLocalId = new Map<string, number>(resumedAdoIdByLocalId);
    // Customer ID's real ref name is runtime-verified per work-item type, not
    // hardcoded (docs/architecture.md's "Customer ID Field Resolution") —
    // cached per type for this confirm() call so discoverFields is called at
    // most once per distinct type in the diff, not once per node.
    const customerIdFieldByType = new Map<string, string | null>();
    // Same runtime-verified, per-type, cached-once resolution for the source
    // traceability field (see resolveSourceRefField's doc comment).
    const sourceRefFieldByType = new Map<string, string | null>();
    let createdCount = 0;

    // A failure anywhere below previously left the job stuck in 'writing'
    // forever -- confirm()'s own guard requires 'diff_ready', so no retry
    // was ever possible again without a manual DB fix. Now that
    // CreatedItemMapping durably records every create/link as it happens
    // (see above), a retry is ALWAYS safe regardless of createdCount: the
    // toCreate/toLink filters below skip anything already durably recorded,
    // so reverting to 'diff_ready' can no longer re-create an already-
    // written item (see the catch block at the end of this method).
    // Collected during the create loop below, upserted into the dedup
    // vector store in ONE batched call after the loop finishes -- previously
    // each newly-created item triggered its own /dedup/upsert call (one
    // embed() round-trip per item) inline in the loop.
    const dedupUpsertItems: { itemId: string; text: string; title: string; areaPath: string }[] = [];

    // Task 2: populated by the trace-link phase's per-link catch below, read
    // after the whole try block succeeds to append a WarningRecord (2c) to
    // the same job.update that flips status to 'succeeded'. Declared out
    // here (not inside the try) specifically so it survives past the try
    // block's closing brace into that final success-path code.
    const traceLinkFailures: { sourceLocalId: string; sourceAdoId: number; targetAdoId: number; referenceName: string }[] = [];

    try {
      // Split into 'already resolved' (reuse/dedup_skip, cheap+sync) vs
      // 'needs a real create' -- the two are handled by completely
      // different phases below.
      const toCreate: typeof diff = [];
      for (const entry of diff) {
        if (isExcluded(entry)) continue;
        // 'dedup_skip' is skipped the same as 'reuse': both already have a
        // real ADO id to point at, just with different certainty (exact-hash
        // fact vs embedding-similarity judgment) — see DryRunDiffEntry's doc
        // comment. Neither should trigger a create.
        if ((entry.action === 'reuse' || entry.action === 'dedup_skip') && entry.existingAdoId !== null) {
          adoIdByLocalId.set(entry.localId, entry.existingAdoId);
          continue;
        }
        // Deselected 'create' rows are dropped entirely here: not created,
        // and (since adoIdByLocalId never gets an entry for them) any child
        // whose parentLocalId points at a deselected node simply won't be
        // linked below -- the same "only link when both ends resolved"
        // guard the dedup_skip-as-child case already relies on.
        if (selectedLocalIds !== undefined && !selectedLocalIds.includes(entry.localId)) {
          continue;
        }
        // Resume: this localId was already created in a prior attempt at
        // this same job (adoIdByLocalId was seeded from resumedAdoIdByLocalId
        // above) -- do not create it again.
        if (resumedAdoIdByLocalId.has(entry.localId)) {
          continue;
        }
        toCreate.push(entry);
      }

      // Confirmed real bug: entry.type ("Epic"/"Feature"/"Requirement", ingestion's
      // own internal category vocabulary) was previously sent AS-IS to ADO as the
      // literal work-item type name -- correct only for a CMMI process template.
      // Agile's Requirement-category type is "User Story", Scrum's is "Product
      // Backlog Item", Basic's is "Issue" -- every one of those would 404 against
      // `_apis/wit/workitems/$Requirement`. Resolved ONCE per confirm() call (only
      // when there's actually something to create -- a resume/retry with nothing
      // left to write skips this ADO round-trip entirely, same as before this
      // existed) via ADO's own universal work-item-type-category concept, which
      // exists identically across every process template. `realType` is used at
      // every point below that sends a type name to ADO (discoverFields via
      // resolveCustomerIdField/resolveSourceRefField, createWorkItem) -- entry.type
      // itself stays the internal category label everywhere else (map keys,
      // sourceRefFieldByType, etc.), since translation only matters at the ADO
      // wire boundary.
      let realType: (type: string) => string = (type) => type;
      if (toCreate.length > 0) {
        await this.jobEventsPublisher?.publishNarration(id, {
          phase: 'writing',
          writeSubPhase: 'discover_types',
          blocksDone: 0,
          blocksTotal: toCreate.length,
          message: 'Resolving work-item type/field configuration for this project',
        });
        const project = job.areaPath.split('\\')[0];
        const workItemTypeCategories = await this.mcpClient.discoverWorkItemTypeCategories(project, credential);
        realType = (type: string): string => workItemTypeCategories[type as keyof typeof workItemTypeCategories] ?? type;
      }

      // Pre-resolve every distinct type's Customer ID field BEFORE the
      // concurrent create phase below -- discoverFields is idempotent, so a
      // race between concurrent creates of the same type would only be
      // wasteful (not incorrect), but resolving up front avoids that
      // entirely and keeps customerIdFieldByType's "at most once per type"
      // guarantee exact even under concurrency.
      for (const entry of toCreate) {
        if (entry.customerId != null && !customerIdFieldByType.has(entry.type)) {
          customerIdFieldByType.set(entry.type, await this.resolveCustomerIdField(realType(entry.type), credential));
        }
        if (entry.sourceRef != null && !sourceRefFieldByType.has(entry.type)) {
          sourceRefFieldByType.set(entry.type, await this.resolveSourceRefField(realType(entry.type), credential));
        }
      }

      // Every create is fully independent of every other create (fields
      // are self-contained; parent linking is a separate phase below that
      // only starts once ALL creates have finished) -- safe to run with
      // bounded concurrency instead of the previous one-ADO-round-trip-at-
      // a-time sequential loop. Concurrency is grouped by parent so that
      // document-order siblings never race each other -- see the grouping
      // immediately below this section. mapWithConcurrency preserves array
      // order in its results regardless of completion order.
      // Unconditional kick-off, even when toCreate is empty -- without this,
      // the frontend ticker sat frozen on 'discover_types' (or a stale
      // "creating -- N of N" from a PRIOR confirm() attempt on a resumed
      // job) for however long this phase actually took, since the first
      // 'create' narration below only fires once item #1 finishes.
      let createProgress = 0;
      await this.jobEventsPublisher?.publishNarration(id, {
        phase: 'writing',
        writeSubPhase: 'create',
        blocksDone: 0,
        blocksTotal: toCreate.length,
        message: `Creating work items in ADO -- 0 of ${toCreate.length}`,
      });
      const createOneWorkItem = async (entry: (typeof toCreate)[number]): Promise<{ id: number }> => {
        const fields: Record<string, string> = {
          'System.Title': entry.title,
          'System.Description': toAdoDescriptionHtml(entry.description),
          'System.State': job.state,
          'System.AreaPath': job.areaPath,
        };
        if (job.iterationPath) {
          fields['System.IterationPath'] = job.iterationPath;
        }
        const tags = [...(entry.tags ?? [])];
        if (entry.customerId != null) {
          const customerIdField = customerIdFieldByType.get(entry.type);
          if (customerIdField !== null && customerIdField !== undefined) {
            fields[customerIdField] = entry.customerId;
          } else {
            // Non-type-gated fallback: this work-item type exposes no
            // Custom.CustomerId-style field at all (e.g. Epic/Feature in the
            // tested org, which only defines it on Requirement) -- rather
            // than silently dropping the customer ID for that type, stamp it
            // into System.Tags (a native field every type has) so it is at
            // least visible somewhere on the item, not lost entirely.
            tags.push(`CustomerId:${entry.customerId}`);
          }
        }
        if (entry.sourceRef != null) {
          const sourceRefField = sourceRefFieldByType.get(entry.type);
          if (sourceRefField !== null && sourceRefField !== undefined) {
            fields[sourceRefField] = JobsService.formatSourceRef(entry.sourceRef);
          } else {
            // Same non-type-gated fallback as Customer ID above: this org
            // exposes no Custom.SourceReference-style field at all for this
            // work-item type -- rather than silently dropping traceability
            // (the previous behavior), stamp it into System.Tags so it's at
            // least visible somewhere. NOT appended to System.Description --
            // that's rejected elsewhere in this file as violating BASELINE's
            // verbatim-fidelity guarantee (see resolveSourceRefField's own
            // doc comment).
            tags.push(`SourceRef:${JobsService.formatSourceRef(entry.sourceRef)}`);
          }
        }
        // System.Tags is a native ADO field on every work-item type (unlike
        // Custom.CustomerId/SourceRef, it needs no discoverFields gating).
        // Deliberately NOT also writing Microsoft.VSTS.CMMI.RequirementType:
        // that field is picklist-constrained by the org's process template,
        // and ado_discover_fields only returns field *names*, never the
        // allowed values for a field -- writing an unvalidated free-text tag
        // into a picklist field would 400 the entire create on any org whose
        // allowed values don't happen to match our 11-tag taxonomy verbatim.
        if (tags.length > 0) {
          fields['System.Tags'] = tags.join('; ');
        }
        const created = await this.mcpClient.createWorkItem(realType(entry.type), fields, credential);
        await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
        // Durable resume state (P4b): written immediately, not batched at
        // the end of the create loop, so a LATER item in this same
        // mapWithConcurrency batch failing doesn't lose the fact that THIS
        // one was already created -- the next confirm() retry will see this
        // row and skip re-creating it.
        await this.prisma.createdItemMapping.upsert({
          where: { jobId_localId: { jobId: id, localId: entry.localId } },
          create: { jobId: id, localId: entry.localId, adoWorkItemId: created.id },
          update: { adoWorkItemId: created.id },
        });
        createProgress += 1;
        void this.jobEventsPublisher?.publishNarration(id, {
          phase: 'writing',
          writeSubPhase: 'create',
          blocksDone: createProgress,
          blocksTotal: toCreate.length,
          message: `Creating work items in ADO -- ${createProgress} of ${toCreate.length}`,
        });
        return created;
      };

      // Grouped by parent, one group per set of siblings -- concurrency
      // runs ACROSS groups (different parents' subtrees created in
      // parallel), never WITHIN a group. Real requirement this satisfies
      // (clarified live by the user): an ADO "direct links"/tree query
      // sorts each parent's children by System.Id ascending by default,
      // and ADO assigns System.Id in request-ARRIVAL order, not
      // caller-array order -- with flat concurrency, up to
      // writeConcurrency siblings could be in flight for the SAME parent
      // at once, so network jitter alone could hand a LATER document-
      // order child a LOWER id than an earlier one, scrambling the tree
      // view relative to this app's own order. Root-level entries
      // (parentLocalId === null) are grouped under one shared '__root__'
      // key so top-level siblings get the same in-order guarantee.
      const toCreateIndexByLocalId = new Map(toCreate.map((entry, i) => [entry.localId, i] as const));
      const toCreateByParent = new Map<string, typeof toCreate>();
      for (const entry of toCreate) {
        const key = entry.parentLocalId ?? '__root__';
        const list = toCreateByParent.get(key) ?? [];
        list.push(entry);
        toCreateByParent.set(key, list);
      }
      const createResults: SettledResult<{ id: number }>[] = new Array(toCreate.length);
      await mapWithConcurrency(Array.from(toCreateByParent.values()), this.writeConcurrency, async (siblings) => {
        let groupFailed = false;
        for (const entry of siblings) {
          const i = toCreateIndexByLocalId.get(entry.localId);
          if (i === undefined) {
            throw new Error(`Invariant violated: sibling group contains localId "${entry.localId}" that toCreate does not`);
          }
          if (groupFailed) {
            // A preceding sibling in this SAME group already failed --
            // deliberately do not create this one out of turn. Creating it
            // now would let a later-document-order sibling land in ADO
            // before an earlier one that's still unresolved, which is
            // exactly the ordering bug this task exists to prevent. Leaving
            // it un-created (and un-mapped in CreatedItemMapping) means the
            // next confirm() retry creates the whole remaining tail
            // together, in order, once the earlier failure is resolved.
            createResults[i] = {
              status: 'rejected',
              reason: new Error(`Skipped: an earlier sibling under the same parent failed to create; retry will recreate this item in its correct document order`),
            };
            continue;
          }
          try {
            createResults[i] = { status: 'fulfilled', value: await createOneWorkItem(entry) };
          } catch (reason) {
            createResults[i] = { status: 'rejected', reason };
            groupFailed = true;
          }
        }
      });

      let firstCreateError: unknown = null;
      for (let i = 0; i < toCreate.length; i++) {
        const result = createResults[i];
        const entry = toCreate[i];
        if (result.status === 'rejected') {
          firstCreateError ??= result.reason;
          continue;
        }
        adoIdByLocalId.set(entry.localId, result.value.id);
        // Backstop future dedup checks against this newly-real item --
        // collected here, actually upserted in one batched call below.
        dedupUpsertItems.push({ itemId: String(result.value.id), text: entry.description, title: entry.title, areaPath: job.areaPath });
        createdCount += 1;
      }
      if (firstCreateError !== null) {
        throw firstCreateError;
      }

      // Best-effort, same as the per-item version it replaces: a batch
      // upsert failure must not fail writes that already succeeded in ADO —
      // it only means those items' future near-duplicates might not be
      // caught. Trade-off versus the old per-item try/catch: one failure now
      // loses the dedup backstop for the whole batch, not just one item —
      // acceptable, since the batch is one job's worth of creates, and a
      // dedup-service outage failing open for an entire job (not silently
      // for scattered individual items) is easier to notice and re-run.
      if (dedupUpsertItems.length > 0) {
        try {
          await this.ingestionClient.upsertDedupEntriesBatch(dedupUpsertItems);
        } catch (error) {
          // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
          console.error(`Dedup batch upsert failed for ${dedupUpsertItems.length} newly-created item(s):`, error);
        }
      }

      // Every link is independent of every other link (each just PATCHes
      // one child work item's parent relation) -- safe to run with the same
      // bounded concurrency as the create phase, once ALL creates above
      // have finished (adoIdByLocalId is fully populated by this point).
      const toLink = diff.filter((entry) => {
        if (entry.parentLocalId === null) return false;
        if (isExcluded(entry)) return false;
        // Never re-parent an existing ADO item based on a probabilistic
        // dedup match — that would silently mutate real ADO hierarchy off a
        // similarity guess, not a certainty. A NEW child linking UP to a
        // dedup_skip parent is fine (parentAdoId lookup still resolves); only
        // the skip-node-as-a-CHILD case is suppressed here.
        if (entry.action === 'dedup_skip') return false;
        // A 'reuse' match (exact-hash, certain) is an item that already
        // exists in ADO from whenever it was originally created -- it
        // already has its own Parent (Hierarchy-Reverse) relation from that
        // original write. Confirmed live: re-adding that same relation on a
        // later job (e.g. a resubmit of the same document) 400s with
        // TF401349 -- ADO enforces at most one Parent relation per work
        // item and gives this generic error for a second `add`, not a
        // friendly "already linked" one. Same suppression as dedup_skip
        // above, for the same reason: a reuse-matched item's existing
        // position in the hierarchy is not this job's to re-assert.
        if (entry.action === 'reuse') return false;
        // Resume: this localId's link already succeeded in a prior attempt
        // at this same job -- do not PATCH the relation again.
        if (alreadyLinkedLocalIds.has(entry.localId)) return false;
        return adoIdByLocalId.has(entry.localId) && adoIdByLocalId.has(entry.parentLocalId as string);
      });
      // Unconditional kick-off, even when toLink is empty -- previously
      // nothing published at all for an empty toLink, leaving the ticker
      // frozen on the last 'create' narration for the rest of this phase
      // even though linking (trivially) already finished.
      let linkProgress = 0;
      await this.jobEventsPublisher?.publishNarration(id, {
        phase: 'writing',
        writeSubPhase: 'link_parents',
        blocksDone: 0,
        blocksTotal: toLink.length,
        message: `Linking parent/child relations -- 0 of ${toLink.length}`,
      });
      const linkResults = await mapWithConcurrency(toLink, this.writeConcurrency, async (entry) => {
        await this.mcpClient.linkParentChild(
          adoIdByLocalId.get(entry.localId) as number,
          adoIdByLocalId.get(entry.parentLocalId as string) as number,
          credential,
        );
        // Durable resume state (P4b): written immediately per successful
        // link, same rationale as the create-phase upsert above.
        await this.prisma.createdItemMapping.update({
          where: { jobId_localId: { jobId: id, localId: entry.localId } },
          data: { linked: true },
        });
        linkProgress += 1;
        void this.jobEventsPublisher?.publishNarration(id, {
          phase: 'writing',
          writeSubPhase: 'link_parents',
          blocksDone: linkProgress,
          blocksTotal: toLink.length,
          message: `Linking parent/child relations -- ${linkProgress} of ${toLink.length}`,
        });
      });
      const firstLinkError = linkResults.find((r) => r.status === 'rejected');
      if (firstLinkError && firstLinkError.status === 'rejected') {
        throw firstLinkError.reason;
      }

      // Trace-link writes fire last, once every entry in this confirm() call
      // has a real ADO id in adoIdByLocalId — same ordering guarantee the
      // parent-child loop above relies on. Unresolved links (bad customer id,
      // or a targetLocalId that isn't in this diff — e.g. its subtree was
      // excluded) are skipped, never thrown: per the project's "never block"
      // philosophy, a broken trace link must not fail the whole confirm.
      // Flattened once (not the previous per-entry-then-per-link nested
      // Grouped by sourceAdoId, one group per work item -- concurrency runs
      // ACROSS groups (different work items in flight at once), never
      // WITHIN a group. Real, confirmed bug this fixes: two trace-link
      // PATCHes racing against the SAME work item both read its revision
      // before either commits, so the second to land 409s with ADO's own
      // optimistic-concurrency check (TF26071 "changed by someone else since
      // you opened it") -- confirmed live, 8 of 18 figures on one real
      // Feature lost this way, silently (the existing per-link catch below
      // only logs). Serializing writes to the SAME work item removes the
      // self-race entirely; an external actor editing the same item
      // concurrently is a separate, pre-existing, accepted risk this fix
      // does not attempt to cover.
      //
      // This also fixes link ORDER, not just the race. Links for one
      // sourceAdoId are built by iterating diff and each entry's own
      // traceLinks[] in their existing (document/inference) order, then
      // written by a plain sequential for loop with no concurrency inside
      // the group -- link #2 is never sent until link #1's write (including
      // any 409 retry from the transport layer) has resolved. The flat
      // pre-fix array was in this same document order, but mapWithConcurrency
      // let up to writeConcurrency of them race, scrambling completion order
      // (and therefore each PATCH's arrival order in ADO's relations array
      // for that work item).
      //
      // Known residual limitation: ADO writes the *reverse* relation on the
      // target item too, so two links that share an endpoint transitively
      // (100→200 and 200→300) can still race even when grouped by source.
      // Fully closing that needs union-find over both endpoints, which
      // collapses to near-total serialization on a densely-linked document.
      // Grouping by source removes the dominant case (one source, many
      // targets); transport-layer 409 retry (retryWithBackoff) absorbs the
      // rest; Tasks 2-4 make anything that still fails visible and
      // recoverable.
      const toTraceLinkBySource = new Map<number, { targetAdoId: number; referenceName: string; sourceLocalId: string }[]>();
      for (const entry of diff) {
        if (isExcluded(entry)) continue;
        for (const link of entry.traceLinks ?? []) {
          const sourceAdoId = adoIdByLocalId.get(link.sourceLocalId);
          if (sourceAdoId === undefined) continue;
          let targetAdoId: number | undefined;
          if (link.targetKind === 'intraJob' && link.targetLocalId) {
            targetAdoId = adoIdByLocalId.get(link.targetLocalId);
          } else if (link.targetKind === 'crossJob' && link.resolutionStatus === 'resolved') {
            targetAdoId = link.resolvedAdoId;
          }
          if (targetAdoId === undefined) continue;
          const list = toTraceLinkBySource.get(sourceAdoId) ?? [];
          // sourceLocalId is carried alongside the ADO ids so a later write
          // failure (see the catch below) can record JobTraceLinkFailure
          // with the local id the UI's diff view actually renders -- reused
          // from the same link.sourceLocalId already resolved into
          // sourceAdoId above, not re-derived.
          list.push({ targetAdoId, referenceName: link.referenceName, sourceLocalId: link.sourceLocalId });
          toTraceLinkBySource.set(sourceAdoId, list);
        }
      }
      // Compute total link count once up front for the narration -- the
      // ticker's contract is per-link, not per-group. Unconditional kick-off,
      // even when empty, for same rationale as the create/link_parents
      // kick-offs above.
      const traceLinkTotalCount = Array.from(toTraceLinkBySource.values()).reduce((sum, links) => sum + links.length, 0);
      let traceLinkProgress = 0;
      await this.jobEventsPublisher?.publishNarration(id, {
        phase: 'writing',
        writeSubPhase: 'trace_links',
        blocksDone: 0,
        blocksTotal: traceLinkTotalCount,
        message: `Writing trace links -- 0 of ${traceLinkTotalCount}`,
      });
      await mapWithConcurrency(Array.from(toTraceLinkBySource.entries()), this.writeConcurrency, async ([sourceAdoId, links]) => {
        for (const link of links) {
          // Best-effort: a trace-link write failure (rejected rel, deleted
          // crossJob target, transient network error) must not abort confirm()
          // after work items in this call have already been created/parented.
          // try/catch stays INSIDE the callback (not around the
          // mapWithConcurrency call) so mapWithConcurrency never sees a
          // rejection and this phase can never throw a firstError the way the
          // create/link phases above do.
          try {
            await this.mcpClient.linkWorkItems(sourceAdoId, link.targetAdoId, link.referenceName, credential);
          } catch (error) {
            // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
            console.error(`Trace-link write failed for ${sourceAdoId} -> ${link.targetAdoId}:`, error);
            traceLinkFailures.push({ sourceLocalId: link.sourceLocalId, sourceAdoId, targetAdoId: link.targetAdoId, referenceName: link.referenceName });
            // Durable counterpart to the console.error above (Task 2b) --
            // gives Task 3's retry endpoint and the warning appended below
            // (2c) something to read once this best-effort write stays
            // failed past confirm() returning. Upsert (not create): a
            // retried confirm() re-attempting the same link must overwrite
            // the stored error, never 500 on the unique constraint. Own
            // try/catch: a bookkeeping failure here must not break the
            // best-effort contract this whole phase exists for.
            try {
              await this.prisma.jobTraceLinkFailure.upsert({
                where: {
                  jobId_sourceAdoId_targetAdoId_referenceName: {
                    jobId: id,
                    sourceAdoId,
                    targetAdoId: link.targetAdoId,
                    referenceName: link.referenceName,
                  },
                },
                create: {
                  jobId: id,
                  sourceLocalId: link.sourceLocalId,
                  sourceAdoId,
                  targetAdoId: link.targetAdoId,
                  referenceName: link.referenceName,
                  error: (error as Error).message,
                },
                update: { sourceLocalId: link.sourceLocalId, error: (error as Error).message },
              });
            } catch (bookkeepingError) {
              // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
              console.error(`Failed to persist JobTraceLinkFailure for ${sourceAdoId} -> ${link.targetAdoId}:`, bookkeepingError);
            }
          } finally {
            traceLinkProgress += 1;
            void this.jobEventsPublisher?.publishNarration(id, {
              phase: 'writing',
              writeSubPhase: 'trace_links',
              blocksDone: traceLinkProgress,
              blocksTotal: traceLinkTotalCount,
              message: `Writing trace links -- ${traceLinkProgress} of ${traceLinkTotalCount}`,
            });
          }
        }
      });

      // Attach each entry's cited figures (item 20d) last, once every entry
      // in this confirm() call has a real ADO id -- same ordering guarantee
      // the trace-link phase above relies on. Deliberately silent (no
      // narration sub-phase, no frontend indicator): this is a nice-to-have
      // enrichment the attachment itself already surfaces natively in ADO's
      // own work-item view, not a step the user needs live progress for.
      // Resumability comes for free from JobFigureFile's own delete-on-
      // success below -- a row still present after a partial failure is
      // exactly what the next confirm() retry needs to pick up where it
      // left off, with no separate "attached" flag anywhere. Wrapped in its
      // OWN try/catch (unlike the create/link phases above) -- a failure
      // here must never revert an otherwise-successful confirm() back to
      // 'diff_ready' and force the user to re-review a diff whose real ADO
      // writes already fully succeeded.
      try {
        const figureFiles = await this.prisma.jobFigureFile.findMany({ where: { jobId: id } });
        if (figureFiles.length > 0) {
          const figureFileByFigureId = new Map(figureFiles.map((f) => [f.figureId, f]));
          // Grouped by adoId, one group per work item -- concurrency runs
          // ACROSS groups (different work items in flight at once), never
          // WITHIN a group. Real, confirmed bug this fixes: two
          // figure-attachment PATCHes racing against the SAME work item
          // both read its revision before either commits, so the second
          // to land 409s with ADO's own optimistic-concurrency check
          // (TF26071 "changed by someone else since you opened it") --
          // confirmed live, 8 of 18 figures on one real Feature lost this
          // way, silently (the existing per-figure catch below only
          // logs). Serializing uploads to the SAME work item removes the
          // self-race entirely; an external actor editing the same item
          // concurrently is a separate, pre-existing, accepted risk this
          // fix does not attempt to cover.
          const toAttachByAdoId = new Map<number, Set<string>>();
          for (const entry of diff) {
            if (isExcluded(entry)) continue;
            const adoId = adoIdByLocalId.get(entry.localId);
            if (adoId === undefined) continue;
            for (const figureId of entry.figureIds ?? []) {
              if (figureFileByFigureId.has(figureId)) {
                const set = toAttachByAdoId.get(adoId) ?? new Set<string>();
                set.add(figureId);
                toAttachByAdoId.set(adoId, set);
              }
            }
          }
          await mapWithConcurrency(Array.from(toAttachByAdoId.entries()), this.writeConcurrency, async ([adoId, figureIds]) => {
            for (const figureId of figureIds) {
              const figureFile = figureFileByFigureId.get(figureId);
              if (!figureFile) continue;
              // Best-effort per figure too: one failed attachment must not
              // stop the rest of this job's figures from attaching.
              try {
                await this.mcpClient.uploadAttachment(
                  adoId,
                  `${figureId}.png`,
                  Buffer.from(figureFile.bytes).toString('base64'),
                  figureFile.mimeType,
                  credential,
                );
                await this.prisma.jobFigureFile.delete({ where: { id: figureFile.id } });
              } catch (error) {
                // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
                console.error(`Figure attachment failed for ADO work item ${adoId}, figure ${figureId}:`, error);
              }
            }
          });
        }
      } catch (error) {
        // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
        console.error(`Figure-attachment phase failed for job ${id}:`, error);
      }
    } catch (error) {
      // Always safe to retry now: CreatedItemMapping durably recorded every
      // create/link that succeeded before this failure, so the next
      // confirm() call will skip them rather than re-creating/re-linking --
      // unlike before P4b existed, a partial write here no longer needs to
      // be marked 'failed' to avoid duplicating already-written items.
      await this.prisma.job.update({ where: { id }, data: { status: 'diff_ready' } });
      await this.prisma.auditEntry.create({
        data: { jobId: id, message: `Confirm failed (safe to retry): ${(error as Error).message}` },
      });
      throw error;
    }

    // Refresh dryRunDiff so GET /jobs/:id stops serving the frozen
    // pre-confirm snapshot forever after a job succeeds -- confirmed real
    // bug: every entry kept existingAdoId: null even on a fully 'succeeded'
    // job, which is exactly what NodeDetailPanel.tsx's "not available"
    // placeholder is gated on, so a real, fully-attached figure showed that
    // message forever. Only every entry adoIdByLocalId actually resolved
    // (newly created OR a pre-existing reuse/dedup_skip match) gets
    // rewritten; anything excluded or never resolved is left exactly as it
    // was.
    //
    // This writes existingAdoId ONLY -- it deliberately never touches
    // action. Every entry's action stays exactly what it always was
    // (create/reuse/dedup_skip): getSummary()'s created/reused/dedupSkipped
    // counts and the frontend's dedup_skip badge both read that field
    // directly and must keep reflecting what actually happened, not get
    // collapsed into a generic post-hoc "reuse" label. (A prior version of
    // this refresh did relabel action to 'reuse' for every resolved entry,
    // which silently destroyed the create/reuse/dedup_skip distinction for
    // every pre-existing reuse/dedup_skip match too -- fixed.)
    //
    // Deliberately ONLY done here, on the final success path -- never in
    // the catch block's revert-to-'diff_ready' path above. confirm()
    // refuses to run again once status is 'succeeded' (guarded at the top
    // of this method), so this refresh here is permanent and safe. Doing
    // the same refresh on a partial failure would be actively wrong: a
    // resumed retry's own toLink filter (above) treats action === 'reuse'
    // as "already linked from an earlier, unrelated job -- skip
    // re-linking", which is false for an item this SAME job just created
    // but hadn't linked yet when it failed.
    const updatedDiff = diff.map((entry) => {
      const realAdoId = adoIdByLocalId.get(entry.localId);
      if (realAdoId === undefined) return entry;
      return { ...entry, existingAdoId: realAdoId };
    });
    // Task 2c: confirm() has, until now, only ever READ job.warnings (set by
    // ingestion's /level integrity checks, SURVEY-only) -- this is a new
    // write path, deliberately reusing WarningRecord.kind's `string` (not a
    // closed union) typing: that field is typed loosely precisely so a
    // non-ingestion producer like this one can introduce a new kind without
    // a lockstep ingestion/orchestrator/frontend release (see its own doc
    // comment in dry-run.service.ts). Only appended when this run actually
    // recorded a failure -- a clean run's warnings are left byte-for-byte
    // as they were.
    const existingWarnings = (job.warnings as (WarningRecord | string)[] | null) ?? [];
    const updatedWarnings: (WarningRecord | string)[] =
      traceLinkFailures.length > 0
        ? [
            ...existingWarnings,
            {
              kind: 'trace_link_write_failed',
              severity: 'pipeline_issue',
              // Distinct sourceLocalIds, not one entry per failed link --
              // CollapsibleWarnings.tsx reads nodeIds directly to build
              // jump-to-node links, and a jump target is per-node, not
              // per-link.
              nodeIds: Array.from(new Set(traceLinkFailures.map((f) => f.sourceLocalId))),
              detail: {},
              raw: `${traceLinkFailures.length} trace link${traceLinkFailures.length === 1 ? '' : 's'} failed to write to Azure DevOps and can be retried from the node detail panel.`,
            } satisfies WarningRecord,
          ]
        : existingWarnings;
    await this.prisma.job.update({
      where: { id },
      data: {
        status: 'succeeded',
        confirmedAt: new Date(),
        completedAt: new Date(),
        dryRunDiff: updatedDiff,
        // `as any`: same cast pipeline.worker.ts's own warnings write uses --
        // updatedWarnings is plain JSON-serializable data, but Prisma's
        // generated InputJsonValue union doesn't structurally resolve
        // against a concrete array-of-interface type.
        ...(traceLinkFailures.length > 0 ? { warnings: updatedWarnings as any } : {}),
      },
    });
    await this.prisma.auditEntry.create({
      data: { jobId: id, message: `Job confirmed: ${createdCount} work item(s) created` },
    });
    return { status: 'succeeded', createdCount };
  }
}
