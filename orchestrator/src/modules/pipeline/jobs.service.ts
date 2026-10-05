import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type Job, type PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import type { McpClient } from './mcp.client';
import { IngestionHttpError, type IngestionHttpClient } from './ingestion-http.client';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { DryRunDiffEntry, WarningRecord } from '../writeback/dry-run.service';
import { mapWithConcurrency, type SettledResult } from './map-with-concurrency';
import { filterExcludedDiffEntries, summarizeDiffEntries } from './diff-summary';
import { DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES } from '../../config/customer-id-fields';
import {
  DEFAULT_REQUIREMENT_TYPE_FIELD_CANDIDATES,
  REQUIREMENT_TAG_PRIORITY,
  REQUIREMENT_TAG_TO_ADO_VALUE,
} from '../../config/requirement-type-fields';
import { DEFAULT_SE_COVERAGE_REF_FIELD_CANDIDATES } from '../../config/se-coverage-ref-fields';
import { normalizeAdoStoredHtml, toAdoDescriptionHtml } from './description-html';
import type { JobEventsPublisher } from './job-events.publisher';
import { canNest, canBeRoot } from './canNest';

// SWEEP.md 8a -- how many times mutateDiffVersioned() re-reads and
// re-applies a mutation that lost its optimistic-concurrency race. Two
// concurrent human reviewers collide on a single attempt with vanishing
// probability; three consecutive losses means something pathological (a hot
// write loop, an automation storm), where a 409 telling the caller to back
// off is more honest than spinning.
const DIFF_WRITE_MAX_ATTEMPTS = 3;

// Task 6: mimeType -> file extension for the ADO attachment filename below
// -- JobFigureFile.mimeType is whatever ingestion's own image-sniffing
// reported (see main.py's _sniff_image_mime_type / _rasterize_for_vision),
// so this must cover every raster format ingestion can actually produce,
// not just PNG. Falls back to 'png' for an unrecognized mimeType, matching
// the extension every figure was hardcoded to before this task -- an
// unrecognized type is no worse off than the old behavior.
const FIGURE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
};

// Builds a human-readable ADO attachment filename from a figure's own name
// (Task 5), sanitized to characters ADO accepts, with the real extension
// derived from the figure's stored mimeType -- replaces the previous
// unconditional `${figureId}.png` (meaningless to a reviewer in ADO's own
// attachment list, and silently wrong whenever mimeType wasn't actually
// PNG). Falls back to `${figureId}.{ext}` when the figure has no name, so
// an unnamed figure's filename is unchanged from before this task (still
// gets the CORRECT extension, though -- that half of the fix applies
// unconditionally). The human figure number in the filename is derived
// from figureId's own numeric suffix ("f11" -> 12), the same 0-based-id/
// 1-based-index relationship FigureDescriptionEntry.figureId's own doc
// comment establishes -- not a second, independently-computed index that
// could drift from it.
export function buildFigureAttachmentFilename(figureId: string, name: string | null | undefined, mimeType: string): string {
  const extension = FIGURE_MIME_TO_EXTENSION[mimeType] ?? 'png';
  const fallback = `${figureId}.${extension}`;
  if (!name) return fallback;
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9\- ]+/g, '') // drop anything not alphanumeric/dash/space
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (!sanitized) return fallback;
  const figureNumberMatch = /^f(\d+)$/.exec(figureId);
  const figureNumber = figureNumberMatch ? Number(figureNumberMatch[1]) + 1 : null;
  return figureNumber !== null ? `Figure-${figureNumber}-${sanitized}.${extension}` : `${sanitized}.${extension}`;
}

export interface SubmitJobInput {
  areaPath: string;
  // The ADO project this job writes into -- see Job.adoProject's own
  // schema.prisma doc comment. Optional/nullable, same convention as
  // batchId/documentOverview/model below -- omitted means null, which
  // hard-fails once it reaches confirm()'s actual write path (never
  // silently defaulted there).
  adoProject?: string | null;
  // The submitting user's stable ADO identity -- the Knowledge Base scope
  // key ingestion's /level uses for KB grounding, kept separate from
  // areaPath (ADO write-back destination + idempotency key only). Nullable:
  // KB grounding simply stays off for a job with no resolved identity.
  userId: string | null;
  mode: 'baseline' | 'survey';
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
  // Set only when this job was created by BatchService.pumpOnce() (NEW-05
  // batch/folder ingestion) -- passed straight into the Job row (see
  // Job.batchId's own schema.prisma doc comment for why it's relation-free).
  // undefined for every non-batch caller, same as every other optional field
  // here -- no behavior change to any existing submit() caller.
  batchId?: string | null;
  // Generated in the wizard's SURVEY-only "Confirm understanding" step
  // (see DocumentOverviewService), BEFORE this Job row exists -- passed
  // straight through here, never recomputed. Always undefined/null for
  // BASELINE, or for a SURVEY submission whose generation call failed at
  // wizard time (fail-open, same convention as every other optional
  // LLM-dependent signal in this codebase).
  documentOverview?: { synopsis: string; caveat: string | null } | null;
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
  // Set only for a job submitted as part of a batch (NEW-05) -- lets
  // JobsList render a "Batch" chip linking back to the batch's own status
  // page. null/undefined for the overwhelming majority of jobs.
  batchId: string | null;
}

export interface JobDetail {
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
  // {figureIndex, figureId, name, caption}[] -- see Job.figureDescriptions'
  // schema.prisma doc comment. Defaults to [] for a historical job (null
  // column), same convention as warnings above. `name` is the document's
  // own figure title (Task 5); a historical job's entries predate this
  // field and will simply have it undefined, read as absent by callers.
  figureDescriptions: { figureIndex: number; figureId: string; name: string | null; caption: string | null }[];
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
  // The ADO project this job writes into -- see Job.adoProject's own
  // schema.prisma doc comment. Exposed so the frontend can derive its
  // "team project" display value from the real column instead of
  // re-deriving it from areaPath client-side.
  adoProject: string | null;
  // Real Job columns (schema.prisma) that were fetched here all along
  // (findUnique with no select clause) but silently dropped by this
  // method's own narrow return object -- the frontend's DestinationBar
  // never had a value to render, showing "not set" and "—" regardless of
  // what a job was actually configured with.
  iterationPath: string | null;
  state: string;
  originalFilename: string;
  userId: string | null;
  // Task 4: exposes JobTraceLinkFailure rows so the client can tell a
  // written trace link from a failed one (today TraceLinkChips renders
  // both identically) and offer a retry (POST
  // :id/trace-links/:failureId/retry, retryTraceLinkWrite above). `error`/
  // `createdAt`/`jobId` are omitted -- not needed by the frontend, which
  // only needs this row's own id (to call the retry endpoint) plus enough
  // fields to match it to the trace link it renders.
  traceLinkFailures: { id: string; sourceLocalId: string; sourceAdoId: number; targetAdoId: number; referenceName: string }[];
  // Count of durable CreatedItemMapping rows (see confirm()'s resume
  // support, P4b) -- for a 'diff_ready' job, a nonzero count means a
  // PRIOR confirm() attempt already wrote some items before failing
  // (confirm()'s own catch reverts status to 'diff_ready', see its doc
  // comment). Lets JobDetail show the reviewer what's already written
  // before they click Confirm again, instead of a blind re-submit --
  // same `_count` pattern `list()` above already uses.
  createdItemCount: number;
  documentOverview: { synopsis: string; caveat: string | null } | null;
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
    // Trailing, after jobEventsPublisher (not alongside customerIdFieldCandidates
    // above) so every existing test call site constructing JobsService with a
    // shorter positional arg list keeps working unchanged -- same reasoning as
    // jobEventsPublisher's own placement.
    private readonly requirementTypeFieldCandidates: string[] = DEFAULT_REQUIREMENT_TYPE_FIELD_CANDIDATES,
    // Trailing, same placement reasoning as requirementTypeFieldCandidates
    // above. Empty by default (see se-coverage-ref-fields.ts's own doc
    // comment) -- so resolveSeCoverageRefField finds no candidate on any
    // org until this is explicitly configured, and seCoverageRef simply
    // never reaches ADO until then.
    private readonly seCoverageRefFieldCandidates: string[] = DEFAULT_SE_COVERAGE_REF_FIELD_CANDIDATES,
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
        // Only id/status are ever read below (bullJob lookup by id, the
        // audit message text) -- selecting every column pulled the full
        // dryRunDiff JSON (can be multi-MB) across the wire for every
        // candidate row on every process startup for no reason.
        select: { id: true, status: true },
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
        adoProject: input.adoProject ?? null,
        userId: input.userId,
        state: input.state ?? this.initialState,
        iterationPath: input.iterationPath ?? null,
        originalFilename: input.filename,
        batchId: input.batchId ?? null,
        documentOverview: input.documentOverview
          ? (input.documentOverview as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
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
        adoProject: input.adoProject ?? null,
        userId: input.userId,
        mode: input.mode,
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
  // (keyed on sourceHash+areaPath) correctly REUSES the same ADO
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
      adoProject: job.adoProject,
      userId: job.userId,
      mode: job.mode as 'baseline' | 'survey',
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
      // Same bug shape as model above: a resubmit that omits this silently
      // drops the original run's Confirm-understanding synopsis/caveat for a
      // SURVEY job. job.documentOverview is the ORIGINAL job's persisted
      // value (null for BASELINE or a SURVEY job whose wizard-time
      // generation failed) -- forwarding it, not recomputing it, matches
      // submit()'s own doc comment: this is generated once, at wizard time,
      // never recomputed later.
      documentOverview: job.documentOverview as { synopsis: string; caveat: string | null } | null,
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

  // Per-confirm()-call memo of ado_discover_fields_detailed, keyed by the
  // REAL work-item type name -- introduced so resolveCustomerIdField,
  // resolveSourceRefField, and (Phase 4) the classification field resolver
  // all share ONE ADO round-trip per work-item type instead of one each.
  // Field, not local variable: confirm()'s create phase resolves multiple
  // types concurrently (mapWithConcurrency below), so this must survive
  // across those calls within a single confirm() invocation, not be
  // recreated per call. Cleared implicitly per confirm() invocation since
  // JobsService itself is request-scoped-by-convention here (a fresh
  // Map per call would also work, but every resolver already threads
  // `credential` through per-call, so a per-call Map is simpler to reason
  // about than a field that must remember to reset) -- see confirm()'s own
  // instantiation of this Map at the top of its create phase.
  private async fieldsFor(
    fieldsByType: Map<string, Promise<{ referenceName: string; allowedValues: string[]; alwaysRequired: boolean }[]>>,
    workItemType: string,
    project: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<{ referenceName: string; allowedValues: string[]; alwaysRequired: boolean }[]> {
    let pending = fieldsByType.get(workItemType);
    if (!pending) {
      pending = this.mcpClient.discoverFieldsDetailed(workItemType, project, credential);
      fieldsByType.set(workItemType, pending);
    }
    return pending;
  }

  // docs/architecture.md's "Customer ID Field Resolution": verified at
  // runtime against ado_discover_fields_detailed, never hardcoded to
  // System.CustomerId (System.* is ADO's reserved built-in namespace, not
  // custom fields). Candidate priority list is configurable
  // (CUSTOMER_ID_FIELD_CANDIDATES), defaulting to DocGen's real-world
  // discovered naming conventions; each candidate is verified present
  // before use rather than trusted blind. If none match on this work-item
  // type, resolveCustomerIdField itself leaves it off (traceability
  // metadata, not a required field) -- and, since the drop-don't-tag fix,
  // that's the end of it: no System.Tags fallback stamps it anywhere else.
  private async resolveCustomerIdField(
    fieldsByType: Map<string, Promise<{ referenceName: string; allowedValues: string[]; alwaysRequired: boolean }[]>>,
    workItemType: string,
    project: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const availableFields = (await this.fieldsFor(fieldsByType, workItemType, project, credential)).map((f) => f.referenceName);
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
  // real and non-destructive. Left off (not a hard failure, and -- since the
  // drop-don't-tag fix -- not a System.Tags fallback either) when no candidate
  // field exists on that work-item type, exactly like Customer ID.
  private async resolveSourceRefField(
    fieldsByType: Map<string, Promise<{ referenceName: string; allowedValues: string[]; alwaysRequired: boolean }[]>>,
    workItemType: string,
    project: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const candidates = ['Custom.SourceReference', 'Custom.SourceDocument', 'Custom.TraceabilityRef'];
    const availableFields = (await this.fieldsFor(fieldsByType, workItemType, project, credential)).map((f) => f.referenceName);
    return candidates.find((candidate) => availableFields.includes(candidate)) ?? null;
  }

  // Same runtime-verified resolution pattern as resolveCustomerIdField/
  // resolveSourceRefField. Candidate list is empty by default (see
  // se-coverage-ref-fields.ts's own doc comment), so this resolves to null
  // on every org until SE_COVERAGE_REF_FIELD_CANDIDATES is explicitly
  // configured -- seCoverageRef stays reviewer-editable in the diff, just
  // never reaches ADO until then. No System.Tags fallback, ever, for this
  // field -- same "drop, don't tag" rule as Customer ID/source ref.
  private async resolveSeCoverageRefField(
    fieldsByType: Map<string, Promise<{ referenceName: string; allowedValues: string[]; alwaysRequired: boolean }[]>>,
    workItemType: string,
    project: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const availableFields = (await this.fieldsFor(fieldsByType, workItemType, project, credential)).map((f) => f.referenceName);
    return this.seCoverageRefFieldCandidates.find((candidate) => availableFields.includes(candidate)) ?? null;
  }

  // Same runtime-verified resolution pattern as resolveCustomerIdField, but
  // ALSO needs the field's real allowedValues (not just its name) -- this is
  // exactly what ado_discover_fields_detailed (Phase 1) exists for. Unlike
  // Customer ID / source ref, resolving no candidate field here is not the
  // end of the story on its own: resolveClassificationValue below still has
  // to decide, per-Requirement, whether any of its tags actually map to one
  // of the field's real values.
  private async resolveRequirementTypeField(
    fieldsByType: Map<string, Promise<{ referenceName: string; allowedValues: string[]; alwaysRequired: boolean }[]>>,
    workItemType: string,
    project: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<{ referenceName: string; allowedValues: string[] } | null> {
    const fields = await this.fieldsFor(fieldsByType, workItemType, project, credential);
    for (const candidate of this.requirementTypeFieldCandidates) {
      const match = fields.find((f) => f.referenceName === candidate);
      if (match) {
        return { referenceName: match.referenceName, allowedValues: match.allowedValues };
      }
    }
    return null;
  }

  // Collapses a Requirement's classification tags (WorkItemNode.tags, up to
  // 11 possible values) into the single value ADO's picklist-constrained
  // field can actually hold. Matched case/whitespace-insensitively against
  // the field's REAL allowedValues (never assumed present verbatim, even
  // for a value this codebase's own REQUIREMENT_TAG_TO_ADO_VALUE table
  // expects to exist) -- an org on a legacy api-version that doesn't honor
  // $expand=allowedValues (Phase 1) simply resolves an empty allowedValues
  // list, which correctly makes every tag "unmappable" there rather than
  // risking an unvalidated write.
  //
  // REQUIREMENT_TAG_PRIORITY decides the winner when more than one of the
  // Requirement's tags maps to a real value (product-owner-confirmed,
  // safety-first order). Returns null when NONE of the Requirement's tags
  // map to anything the org's field actually allows -- the caller (below)
  // is responsible for warning in that case, not this pure function.
  private static resolveClassificationValue(tags: string[], allowedValues: string[]): string | null {
    const normalizedAllowed = new Map(allowedValues.map((value) => [value.toLowerCase().trim(), value]));
    for (const tag of REQUIREMENT_TAG_PRIORITY) {
      if (!tags.includes(tag)) continue;
      const mapped = REQUIREMENT_TAG_TO_ADO_VALUE[tag];
      const real = mapped ? normalizedAllowed.get(mapped.toLowerCase()) : undefined;
      if (real !== undefined) {
        return real;
      }
    }
    return null;
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

  async getById(id: string): Promise<JobDetail | null> {
    const job = await this.prisma.job.findUnique({
      where: { id },
      include: { traceLinkFailures: true, _count: { select: { createdItemMappings: true } } },
    });
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      mode: job.mode,
      dryRunDiff: job.dryRunDiff,
      warnings: (job.warnings as (WarningRecord | string)[] | null) ?? [],
      kbCitations: job.kbCitations,
      figureDescriptions:
        (job.figureDescriptions as { figureIndex: number; figureId: string; name: string | null; caption: string | null }[] | null) ?? [],
      tableDescriptions: (job.tableDescriptions as { tableId: string; caption: string }[] | null) ?? [],
      excludedFigureIds: (job.excludedFigureIds as string[] | null) ?? [],
      excludedTableIds: (job.excludedTableIds as string[] | null) ?? [],
      createdAt: job.createdAt,
      areaPath: job.areaPath,
      adoProject: job.adoProject,
      iterationPath: job.iterationPath,
      state: job.state,
      originalFilename: job.originalFilename,
      userId: job.userId,
      traceLinkFailures: (job.traceLinkFailures ?? []).map((f) => ({
        id: f.id,
        sourceLocalId: f.sourceLocalId,
        sourceAdoId: f.sourceAdoId,
        targetAdoId: f.targetAdoId,
        referenceName: f.referenceName,
      })),
      createdItemCount: job._count.createdItemMappings,
      documentOverview: job.documentOverview as { synopsis: string; caveat: string | null } | null,
    };
  }

  // `userId` scopes the list to one caller's own jobs (ownership, matching
  // getById/every other per-job route below) -- undefined only in the
  // legacy pre-auth test suite's direct service calls, never in a real
  // request (the controller always resolves a session's userId first).
  async list(userId?: string, pagination?: { skip?: number; take?: number }): Promise<JobSummary[]> {
    const rows = await this.prisma.job.findMany({
      where: userId ? { userId } : {},
      // { id: 'desc' } as a tiebreaker: createdAt alone is not unique, so
      // with skip/take pagination, rows sharing a timestamp would have
      // unspecified relative order between page queries -- the classic
      // offset-pagination bug where a row can appear on two pages or be
      // skipped entirely.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: pagination?.skip,
      take: pagination?.take,
      select: {
        id: true,
        mode: true,
        status: true,
        areaPath: true,
        originalFilename: true,
        createdAt: true,
        batchId: true,
        _count: { select: { createdItemMappings: true } },
      },
    });
    if (rows.length === 0) return [];
    // itemCount previously came from selecting the full dryRunDiff JSON
    // column (can be multi-MB on a large document) just to read its
    // .length -- ×N retained jobs made this list endpoint transfer and
    // JSON-parse hundreds of MB for a screen that renders a count. One
    // small raw-SQL query computes the count IN Postgres instead; the
    // jsonb_typeof guard mirrors dryRunDiff's own nullable-JSON contract
    // (a job with no diff yet, or a non-array legacy value, counts as 0
    // rather than erroring jsonb_array_length on a non-array).
    const ids = rows.map((row) => row.id);
    const itemCounts = await this.prisma.$queryRaw<{ id: string; itemCount: number }[]>`
      SELECT id, CASE WHEN jsonb_typeof("dryRunDiff") = 'array' THEN jsonb_array_length("dryRunDiff") ELSE 0 END AS "itemCount"
      FROM "Job" WHERE id = ANY(${ids})
    `;
    const itemCountById = new Map(itemCounts.map((row) => [row.id, Number(row.itemCount)]));
    return rows.map((row) => ({
      id: row.id,
      mode: row.mode,
      status: row.status,
      areaPath: row.areaPath,
      originalFilename: row.originalFilename,
      itemCount: itemCountById.get(row.id) ?? 0,
      createdItemCount: row._count.createdItemMappings,
      createdAt: row.createdAt,
      batchId: row.batchId,
    }));
  }

  // SWEEP.md 8a -- the one optimistic-concurrency guard shared by all five
  // dryRunDiff mutation endpoints (setDiffEntryExcluded, editDiffEntry,
  // rescoreDiffEntry, addDiffEntry, moveDiffEntry). Each of them previously
  // did findUnique -> mutate the array in JS -> update({ where: { id } }),
  // so two clients editing DIFFERENT nodes both read the same array, each
  // wrote back their own full copy, and the later write silently discarded
  // the earlier one -- with both callers getting a 200. The conditional
  // updateMany below closes that window the same way confirm()'s atomic
  // status claim does: the where-clause is evaluated by Postgres as part of
  // the single UPDATE, so a write whose read is already stale matches zero
  // rows instead of clobbering.
  //
  // On count === 0 this RE-READS and RE-APPLIES rather than 409ing the
  // caller. These five mutations are per-node and disjoint, so the
  // overwhelmingly common collision -- two clients on two different nodes,
  // the exact scenario the SWEEP item names -- has no semantic conflict at
  // all and both edits genuinely should land. That is also already the
  // product's stated policy: JobDetail.tsx's handleBulkExclude serializes
  // its calls precisely so every edit lands (see its own comment), and none
  // of the frontend's diff-mutation handlers branch on status code, so a
  // 409 would surface as an indistinguishable generic toast and force the
  // user to redo the edit by hand. Same-node collisions still resolve
  // last-writer-wins after the retry, exactly as they do today -- so this
  // strictly dominates the previous behavior and makes no case worse.
  //
  // CONTRACT: `mutate` may be called more than once. It MUST be a pure
  // re-derivation from the `diff`/`job` it is handed on that attempt --
  // never a closure over a previous attempt's array, and never carrying an
  // external side effect. rescoreDiffEntry's ingestion /score-item call is
  // deliberately hoisted OUT of its mutator for exactly this reason (an
  // LLM call re-run per retry would re-bill and could persist a different
  // score depending on retry luck). A validation throw from `mutate` is
  // final and stops retrying, which is correct: it was evaluated against a
  // freshly-read array.
  private async mutateDiffVersioned(
    id: string,
    mutate: (diff: DryRunDiffEntry[], job: Job) => DryRunDiffEntry[],
  ): Promise<DryRunDiffEntry[]> {
    for (let attempt = 1; attempt <= DIFF_WRITE_MAX_ATTEMPTS; attempt += 1) {
      const job = await this.prisma.job.findUnique({ where: { id } });
      if (!job) throw new NotFoundException(`Job ${id} not found`);
      if (job.status !== 'diff_ready') {
        throw new ConflictException(`Job ${id} is not in a diff-editable state`);
      }
      const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
      const next = mutate(diff, job);
      const written = await this.prisma.job.updateMany({
        // `status: 'diff_ready'` belongs on the WRITE, not just on the read
        // above: the read is check-then-act, so without it a mutation whose
        // read happened before confirm() atomically claimed status:'writing'
        // could still match on diffVersion alone and clobber confirm()'s
        // post-ADO dryRunDiff refresh (which deliberately does NOT bump
        // diffVersion -- see schema.prisma's diffVersion comment) with a
        // stale array. On count === 0 the retry loop re-reads, sees the new
        // status, and throws the not-diff-editable ConflictException.
        where: { id, status: 'diff_ready', diffVersion: job.diffVersion },
        data: { dryRunDiff: next as any, diffVersion: { increment: 1 } },
      });
      if (written.count === 1) return next;
    }
    throw new ConflictException(
      `Job ${id}'s review tree was changed by another request while this edit was being applied -- please retry.`,
    );
  }

  async setDiffEntryExcluded(id: string, localId: string, excluded: boolean): Promise<DryRunDiffEntry[]> {
    return this.mutateDiffVersioned(id, (diff) => {
      const index = diff.findIndex((entry) => entry.localId === localId);
      if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
      diff[index] = { ...diff[index], excluded };
      return diff;
    });
  }

  // Advisory "I've checked these" flag, set in bulk so marking 80 items is
  // one request and one version bump instead of 80 racing read-modify-writes.
  // Never read by confirm() -- see DryRunDiffEntry.reviewed.
  async setDiffEntriesReviewed(id: string, localIds: string[], reviewed: boolean): Promise<DryRunDiffEntry[]> {
    return this.mutateDiffVersioned(id, (diff) => {
      const wanted = new Set(localIds);
      const found = new Set<string>();
      const next = diff.map((entry) => {
        if (!wanted.has(entry.localId)) return entry;
        found.add(entry.localId);
        return !!entry.reviewed === reviewed ? entry : { ...entry, reviewed };
      });
      if (found.size !== wanted.size) {
        const missing = [...wanted].filter((localId) => !found.has(localId));
        throw new NotFoundException(`Diff entries not found: ${missing.slice(0, 5).join(', ')}`);
      }
      return next;
    });
  }

  // Re-runs ONE failed optional enhancement pass for a few of the items its
  // warning lists, so a handful of failures doesn't need a whole-job
  // resubmit. The caller sends the ids (a batch at a time) and loops; the
  // server never runs minutes of LLM work inside one request.
  //
  // Same shape as rescoreDiffEntry: the LLM call sits OUTSIDE the version-
  // guarded write (it costs money and can answer differently per call, so a
  // write retry must never re-run it), and the write re-checks, against the
  // freshly-read array, that each item is still the one that was sent --
  // never overwriting an edit made while the call was in flight.
  async retryEnhancement(
    id: string,
    input: { kind: string; pass: 'title_tag' | 'synthesis'; localIds: string[] },
  ): Promise<{
    dryRunDiff: DryRunDiffEntry[];
    warnings: (WarningRecord | string)[];
    enhanced: string[];
    failed: string[];
    skipped: string[];
  }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    if (job.status !== 'diff_ready') {
      throw new ConflictException(`Job ${id} is not in a diff-editable state`);
    }
    const isMatching = (warning: WarningRecord | string): warning is WarningRecord =>
      typeof warning !== 'string' && warning.kind === input.kind && warning.detail?.pass === input.pass;
    const listed = new Set(
      ((job.warnings as (WarningRecord | string)[] | null) ?? []).filter(isMatching).flatMap((w) => w.nodeIds),
    );
    if (listed.size === 0) {
      throw new NotFoundException(`No ${input.kind} warning for the ${input.pass} pass on job ${id}`);
    }
    const notListed = input.localIds.filter((localId) => !listed.has(localId));
    if (notListed.length > 0) {
      throw new BadRequestException(`Not part of this warning: ${notListed.slice(0, 5).join(', ')}`);
    }

    // Phase 1: what to send. Excluded items are left alone (their text won't
    // reach ADO), as is anything that isn't a plain proposed item.
    const diff = (job.dryRunDiff as unknown as DryRunDiffEntry[]) ?? [];
    const byId = new Map(diff.map((entry) => [entry.localId, entry]));
    const parentChain = (entry: DryRunDiffEntry): string => {
      const titles: string[] = [];
      const seen = new Set<string>();
      let current = entry.parentLocalId;
      while (current && !seen.has(current)) {
        seen.add(current);
        const ancestor = byId.get(current);
        if (!ancestor) break;
        titles.push(ancestor.title);
        current = ancestor.parentLocalId;
      }
      return titles.reverse().join(' > ');
    };
    const sentText = new Map<string, string>();
    const skipped: string[] = [];
    const items: { id: string; text: string; type: string; context: string }[] = [];
    for (const localId of input.localIds) {
      const entry = byId.get(localId);
      if (!entry || entry.action !== 'create' || entry.excluded || entry.isManual) {
        skipped.push(localId);
        continue;
      }
      sentText.set(localId, entry.description);
      items.push({ id: localId, text: entry.description, type: entry.type, context: parentChain(entry) });
    }
    if (items.length === 0) {
      return { dryRunDiff: diff, warnings: (job.warnings as (WarningRecord | string)[] | null) ?? [], enhanced: [], failed: [], skipped };
    }

    // Phase 2: the model call, once.
    let outcome: Awaited<ReturnType<IngestionHttpClient['enhanceItems']>>;
    try {
      outcome = await this.ingestionClient.enhanceItems(input.pass, items, job.userId ?? undefined, job.model ?? undefined);
    } catch (err) {
      if (err instanceof IngestionHttpError) throw new BadGatewayException(err.message);
      throw err;
    }

    // Phase 3: apply under the version/status guard. A pure re-derivation
    // from what it reads on each attempt -- the results above are fixed.
    const passLabel = { title_tag: 'title/tag', synthesis: 'text synthesis' }[input.pass];
    for (let attempt = 1; attempt <= DIFF_WRITE_MAX_ATTEMPTS; attempt += 1) {
      const fresh = await this.prisma.job.findUnique({ where: { id } });
      if (!fresh) throw new NotFoundException(`Job ${id} not found`);
      if (fresh.status !== 'diff_ready') {
        throw new ConflictException(`Job ${id} is not in a diff-editable state`);
      }
      const freshDiff = ((fresh.dryRunDiff as unknown as DryRunDiffEntry[]) ?? []).map((entry) => ({ ...entry }));
      const enhanced: string[] = [];
      const changedSince: string[] = [];
      for (const entry of freshDiff) {
        const result = outcome.results[entry.localId];
        if (!result || !sentText.has(entry.localId)) continue;
        if (entry.excluded || entry.description !== sentText.get(entry.localId)) {
          changedSince.push(entry.localId);
          continue;
        }
        if (result.title) entry.title = result.title;
        // Tags are a Requirement-only attribute everywhere else (editDiffEntry,
        // confirm()), so never set them on an Epic/Feature.
        if (result.tags && entry.type === 'Requirement') entry.tags = result.tags;
        if (input.pass === 'synthesis' && result.description) {
          entry.description = result.description;
          if (result.groundingScore != null) entry.groundingScore = result.groundingScore;
          // The score (if any) judged the OLD text -- same stale marking as a manual edit.
          if (entry.qualityScore != null) entry.qualityStale = true;
        }
        enhanced.push(entry.localId);
      }
      const done = new Set(enhanced);
      const freshWarnings = (fresh.warnings as (WarningRecord | string)[] | null) ?? [];
      const nextWarnings: (WarningRecord | string)[] = [];
      for (const warning of freshWarnings) {
        if (!isMatching(warning)) {
          nextWarnings.push(warning);
          continue;
        }
        const remaining = warning.nodeIds.filter((localId) => !done.has(localId));
        if (remaining.length === 0) continue;
        if (remaining.length === warning.nodeIds.length) {
          nextWarnings.push(warning);
          continue;
        }
        nextWarnings.push({
          ...warning,
          nodeIds: remaining,
          raw:
            input.kind === 'enhancement_call_failed'
              ? `The ${passLabel} enhancement call failed for ${remaining.length} item(s) -- those kept their existing text.`
              : `The ${passLabel} enhancement response omitted ${remaining.length} item(s) -- those kept their existing text.`,
        });
      }
      const written = await this.prisma.job.updateMany({
        where: { id, status: 'diff_ready', diffVersion: fresh.diffVersion },
        data: { dryRunDiff: freshDiff as any, warnings: nextWarnings as any, diffVersion: { increment: 1 } },
      });
      if (written.count === 1) {
        const attemptedFailed = items.map((item) => item.id).filter((localId) => !done.has(localId) && !changedSince.includes(localId));
        return {
          dryRunDiff: freshDiff,
          warnings: nextWarnings,
          enhanced,
          failed: attemptedFailed,
          skipped: [...skipped, ...changedSince],
        };
      }
    }
    throw new ConflictException(
      `Job ${id}'s review tree was changed by another request while this retry was being applied -- please retry.`,
    );
  }

  // Marks integrity warnings as handled. Addressed by `kind` (plus, to ack a
  // single record, its `raw` text) rather than by array index: the warnings
  // array is also rewritten elsewhere (a trace-link retry drops/shrinks its
  // own record), which would shift indices under a client holding a stale
  // view. A legacy plain-string warning can't carry the flag and is skipped.
  // Same version/status-guarded retry loop as mutateDiffVersioned, so it
  // can't clobber -- or be clobbered by -- a concurrent diff edit.
  async setWarningsAcknowledged(
    id: string,
    input: { kind: string; raws?: string[]; acknowledged: boolean },
  ): Promise<(WarningRecord | string)[]> {
    for (let attempt = 1; attempt <= DIFF_WRITE_MAX_ATTEMPTS; attempt += 1) {
      const job = await this.prisma.job.findUnique({ where: { id } });
      if (!job) throw new NotFoundException(`Job ${id} not found`);
      if (job.status !== 'diff_ready') {
        throw new ConflictException(`Job ${id} is not in a diff-editable state`);
      }
      const warnings = (job.warnings as (WarningRecord | string)[] | null) ?? [];
      const rawFilter = input.raws ? new Set(input.raws) : null;
      let matched = 0;
      const next = warnings.map((warning) => {
        if (typeof warning === 'string' || warning.kind !== input.kind) return warning;
        if (rawFilter && !rawFilter.has(warning.raw)) return warning;
        matched += 1;
        return !!warning.acknowledged === input.acknowledged ? warning : { ...warning, acknowledged: input.acknowledged };
      });
      if (matched === 0) throw new NotFoundException(`No ${input.kind} warning found on job ${id}`);
      const written = await this.prisma.job.updateMany({
        where: { id, status: 'diff_ready', diffVersion: job.diffVersion },
        data: { warnings: next as any, diffVersion: { increment: 1 } },
      });
      if (written.count === 1) return next;
    }
    throw new ConflictException(
      `Job ${id}'s warnings were changed by another request while this edit was being applied -- please retry.`,
    );
  }

  async editDiffEntry(
    id: string,
    localId: string,
    patch: { title?: string; description?: string; customerId?: string | null; tags?: string[]; seCoverageRef?: string | null },
  ): Promise<DryRunDiffEntry[]> {
    return this.mutateDiffVersioned(id, (diff) => {
      const index = diff.findIndex((entry) => entry.localId === localId);
      if (index === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
      if (diff[index].action !== 'create') {
        throw new BadRequestException('only create entries can be edited');
      }
      // A patch key present with an explicit `undefined` value (as sent by the
      // controller for a caller who never mentioned that field) must not
      // overwrite the existing value — only apply keys the caller actually set.
      const definedPatch: {
        title?: string;
        description?: string;
        customerId?: string | null;
        tags?: string[];
        seCoverageRef?: string | null;
      } = {};
      if (patch.title !== undefined) definedPatch.title = patch.title;
      if (patch.description !== undefined) definedPatch.description = patch.description;
      if (patch.customerId !== undefined) {
        // Customer ID is a per-Requirement, document-derived attribute --
        // Epic/Feature must never carry one, matching the same type gate
        // confirm() itself enforces at ADO-write time (jobs.service.ts's
        // create-loop). Rejecting here, not silently ignoring, since a
        // caller attempting this is almost certainly a UI bug, not a
        // legitimate no-op.
        if (diff[index].type !== 'Requirement') {
          throw new BadRequestException('customerId can only be set on a Requirement entry');
        }
        definedPatch.customerId = patch.customerId;
      }
      if (patch.tags !== undefined) {
        // Same reasoning and same rejection (not silent ignore) as customerId
        // immediately above -- classification is a per-Requirement attribute,
        // matching confirm()'s own Requirement-only write gate.
        if (diff[index].type !== 'Requirement') {
          throw new BadRequestException('tags can only be set on a Requirement entry');
        }
        definedPatch.tags = patch.tags;
      }
      if (patch.seCoverageRef !== undefined) {
        // Same reasoning and same rejection as customerId/tags above.
        if (diff[index].type !== 'Requirement') {
          throw new BadRequestException('seCoverageRef can only be set on a Requirement entry');
        }
        definedPatch.seCoverageRef = patch.seCoverageRef;
      }
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
      return diff;
    });
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
    // SWEEP.md 8a: this read is deliberately NOT the version-guarded one.
    // It exists only to validate the request and gather the LLM call's
    // context (userId/model/category checklist) -- i.e. to decide whether
    // to spend an ingestion /score-item call at all. The guarded read
    // happens inside mutateDiffVersioned below, and every check made here
    // is re-made there against the freshly-read array. The LLM call must
    // sit OUTSIDE the retried region: it costs money, takes seconds, and
    // can return a different score per invocation, so re-running it per
    // retry would make the persisted number depend on retry luck.
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
    // The exact text the LLM is about to judge. Re-checked against the
    // freshly-read array inside the mutator below: the /score-item call takes
    // seconds, and a concurrent editDiffEntry landing in that window would
    // otherwise have this score written against text it never saw, with
    // qualityStale: false -- laundering a stale number as fresh, the very
    // thing DESIGN.md §11.4.4 forbids.
    const scoredDescription = diff[index].description;
    let result: { qualityScore: number | null; qualityIssues: string[]; qualityCategoryScores: Record<string, number> | null; qualityConfidence: string | null };
    try {
      result = await this.ingestionClient.scoreItem(
        scoredDescription,
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
        throw new BadGatewayException({
          statusCode: 502,
          message: err.message,
          error: 'Bad Gateway',
          ...(err.traceback ? { upstreamTraceback: err.traceback } : {}),
        });
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
    // result.qualityConfidence is only typed as `string | null` on
    // IngestionHttpClient.scoreItem's return type -- ingestion's own parsing
    // guarantees the 'high'/'medium'/'low' vocabulary today, but casting
    // straight to the literal union below would let an unexpected value
    // (e.g. a differently-cased string) silently pass through and later be
    // read by isFlaggedDiffEntry as "not low", a silently unflagged item.
    // Narrow at runtime instead of casting, falling back to null.
    const rescoredQualityConfidence =
      result.qualityConfidence === 'high' || result.qualityConfidence === 'medium' || result.qualityConfidence === 'low'
        ? result.qualityConfidence
        : null;
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
    // Re-validate against the FRESHLY-read array, not the phase-1 one: a
    // retry must never apply this score to a localId that no longer exists
    // or to an entry another client meanwhile turned into a non-create /
    // non-Requirement. resolveCategoryChecklist is deliberately NOT
    // re-resolved here -- it fixed the rubric the already-returned score
    // was judged against, and re-resolving it against a fresh array could
    // pick a different sibling's key set, which is exactly the "two
    // different rubrics" hazard its own doc comment above exists to stop.
    return this.mutateDiffVersioned(id, (freshDiff) => {
      const freshIndex = freshDiff.findIndex((entry) => entry.localId === localId);
      if (freshIndex === -1) throw new NotFoundException(`Diff entry ${localId} not found`);
      if (freshDiff[freshIndex].action !== 'create') {
        throw new BadRequestException('only create entries can be rescored');
      }
      if (freshDiff[freshIndex].type !== 'Requirement') {
        throw new BadRequestException('only Requirement entries can be rescored');
      }
      if (freshDiff[freshIndex].description !== scoredDescription) {
        throw new ConflictException(
          'The description changed while the rescore was in flight -- the item was left unchanged.',
        );
      }
      freshDiff[freshIndex] = {
        ...freshDiff[freshIndex],
        qualityScore: result.qualityScore,
        qualityIssues: result.qualityIssues,
        qualityCategoryScores: result.qualityCategoryScores,
        // Overwritten unconditionally, unlike qualityCategoryChecklist above:
        // confidence is a property of THIS judgment of THIS text, so carrying
        // the pre-edit value forward would be exactly the stale-number
        // laundering DESIGN.md §11.4.4 forbids. The `qualityScore == null`
        // guard above already rejected the failed-rescore case, so reaching
        // here means we have a real fresh judgment to write.
        qualityConfidence: rescoredQualityConfidence,
        qualityStale: false,
      };
      return freshDiff;
    });
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
    input: { parentLocalId: string | null; type: string; title: string; description: string },
  ): Promise<DryRunDiffEntry[]> {
    return this.mutateDiffVersioned(id, (diff, job) => {
      let parentEntry: DryRunDiffEntry | undefined;
      if (input.parentLocalId !== null) {
        parentEntry = diff.find((entry) => entry.localId === input.parentLocalId);
        if (!parentEntry) throw new NotFoundException(`Diff entry ${input.parentLocalId} not found`);
      }

      if (job.mode === 'baseline') {
        // BASELINE has no root-creation concept -- every BASELINE item's type
        // is inherited from a real parent's own childType; there is no
        // top-level type to infer without one, so a null parentLocalId is
        // simply not a valid request here (the frontend's AddChildForm never
        // offers root placement in BASELINE mode -- see its own doc comment).
        if (!parentEntry) {
          throw new BadRequestException('a BASELINE job requires an existing parent to add a child under');
        }
        // A manually-added entry's childType is ALWAYS null (never recomputed
        // by ingestion -- see the newEntry literal below), so in BASELINE mode
        // the childType-equality check just below can never be satisfied by
        // any real type string. Without this explicit case the caller would
        // only ever see "does not match the required child type 'null'",
        // which reads as a caller bug rather than what it actually is: a
        // manually-added parent's allowed child type is fundamentally
        // undetermined in a BASELINE job (there's no per-node inference to
        // read a childType from). SURVEY mode has no such gap -- its branch
        // below validates by category via canNest, which manual parents
        // participate in exactly like any other node.
        if (parentEntry.isManual) {
          throw new BadRequestException('cannot add a child under a manually-added entry in a BASELINE job');
        }
        if (input.type !== parentEntry.childType) {
          throw new BadRequestException(`type '${input.type}' does not match the required child type '${parentEntry.childType}'`);
        }
      } else if (parentEntry) {
        // CR: reparent -- was a flat `['Epic','Feature','Requirement'].includes()`
        // membership check with no relationship to the parent's type at all,
        // e.g. a SURVEY job could add an Epic as a child of a Requirement. Now
        // routes through the same canNest tier rule the move endpoint uses, so
        // this path and moveDiffEntry share one definition of "valid parent."
        if (!canNest(input.type, parentEntry.type)) {
          throw new BadRequestException(`a ${input.type} cannot be added under a ${parentEntry.type}`);
        }
      } else {
        // CR: reparent -- root creation in SURVEY mode, mirroring
        // moveDiffEntry's own canBeRoot check (root_regrouping.py's rule: the
        // top category, or a Feature when the document has no Epic at all).
        const anyEpicExists = diff.some((entry) => entry.type === 'Epic');
        if (!canBeRoot(input.type, anyEpicExists)) {
          throw new BadRequestException(`a ${input.type} cannot be a top-level item here`);
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
        seCoverageRef: null,
        tags: [],
        qualityScore: null,
        qualityIssues: [],
        childType: null,
        isManual: true,
      };
      const updated = [...diff, newEntry];
      return updated;
    });
  }

  // Reparent (parentLocalId alone) and/or reorder among siblings
  // (anchorLocalId + placement, parentLocalId unchanged for a pure reorder).
  // Every check below is local to dryRunDiff plus two Prisma reads (the
  // already-linked mapping guard and the version-guarded row read, which
  // re-reads on a lost concurrency race) -- no MCP client call, so this
  // endpoint still has no network round-trip and no 500 surface. See
  // DESIGN.md §11.5 for the UI this backs.
  async moveDiffEntry(
    id: string,
    localId: string,
    input: { parentLocalId: string | null; anchorLocalId?: string | null; placement?: 'before' | 'after' },
  ): Promise<DryRunDiffEntry[]> {
    // Two distinct rules here, not one -- audited end-to-end (see DESIGN.md
    // §11.5's "already in ADO" badge) to confirm this is the complete
    // policy, not just what happened to be reachable:
    //
    // 1. REJECT a move that would be CONTRADICTED by a write this job
    //    already made. `mapping.linked` means a prior confirm attempt on
    //    THIS job already ran linkParentChild for this localId under its
    //    OLD parent -- linkParentChild only ever does op:'add' on
    //    /relations/-, there is no remove path anywhere in the MCP server,
    //    so a new parentLocalId here could never actually reach ADO on a
    //    resumed confirm. Reject rather than let the tree silently diverge
    //    from what confirm() will really do.
    // 2. ALLOW, and label in the UI, a move that can never reach ADO at
    //    all. A 'reuse'/'dedup_skip' entry (existingAdoId set) has no
    //    CreatedItemMapping row -- THIS job never created or linked it --
    //    so `mapping` is null and this check is a no-op for it. That's
    //    intentional, not an oversight: confirm()'s own toLink filter
    //    (this same file) unconditionally excludes both actions from
    //    linkParentChild -- ADO enforces at most one Parent relation per
    //    work item (confirmed live: re-adding one 400s with TF401349), and
    //    a matched item's real position is not this job's to re-assert.
    //    The move is still allowed to persist in dryRunDiff because it's a
    //    legitimate, real thing for a reviewer to want: reorganizing this
    //    REVIEW tree for their own reading, independent of whether ADO's
    //    real hierarchy moves with it. See DiffTree.tsx's badge for the one
    //    thing this move DOES still affect for real: a brand-new item
    //    placed as this entry's child links for real, on confirm.
    //
    // SWEEP.md 8a: hoisted above the version-guarded read below because
    // that guard's mutator is synchronous and because this lookup is keyed
    // on { jobId, localId } alone -- it does not depend on the diff array,
    // so issuing it once rather than once per retry attempt changes nothing
    // about what it checks.
    const mapping = await this.prisma.createdItemMapping.findUnique({
      where: { jobId_localId: { jobId: id, localId } },
    });
    if (mapping?.linked) {
      throw new ConflictException(`Diff entry ${localId} is already linked in Azure DevOps and cannot be reparented`);
    }

    return this.mutateDiffVersioned(id, (diff) => {
      const entry = diff.find((e) => e.localId === localId);
      if (!entry) throw new NotFoundException(`Diff entry ${localId} not found`);
      const newParent = input.parentLocalId !== null ? diff.find((e) => e.localId === input.parentLocalId) : null;
      if (input.parentLocalId !== null && !newParent) {
        throw new NotFoundException(`Diff entry ${input.parentLocalId} not found`);
      }

      // Cycle guard -- confirm()'s own isExcluded() walks parentLocalId
      // ancestry with no cycle check and would infinite-loop in production on
      // a cyclic tree; this is the one place a cycle could be introduced.
      if (input.parentLocalId !== null) {
        let cursor: DryRunDiffEntry | undefined = newParent ?? undefined;
        while (cursor) {
          if (cursor.localId === localId) {
            throw new BadRequestException('cannot move an item inside its own descendant');
          }
          cursor = cursor.parentLocalId ? diff.find((e) => e.localId === cursor!.parentLocalId) : undefined;
        }
      }

      // Tier rule -- same-tier (e.g. Epic under Epic) is intentionally
      // ALLOWED here (see DESIGN.md §11.5's `same tier` badge) even though
      // it's flagged client-side; only an actual tier violation is rejected.
      if (newParent) {
        if (!canNest(entry.type, newParent.type)) {
          throw new BadRequestException(`a ${entry.type} cannot be nested under a ${newParent.type}`);
        }
      } else {
        const anyEpicExists = diff.some((e) => e.type === 'Epic');
        if (!canBeRoot(entry.type, anyEpicExists)) {
          throw new BadRequestException(`a ${entry.type} cannot be a top-level item here`);
        }
      }

      const fromIndex = diff.indexOf(entry);
      diff.splice(fromIndex, 1);
      entry.parentLocalId = input.parentLocalId;

      let insertAt: number;
      if (input.anchorLocalId) {
        const anchorIndex = diff.findIndex((e) => e.localId === input.anchorLocalId);
        if (anchorIndex === -1) throw new NotFoundException(`Diff entry ${input.anchorLocalId} not found`);
        // CR: reparent review fix -- the anchor must actually be a sibling
        // under the requested parentLocalId. DiffTree.tsx always supplies a
        // real sibling as the anchor, so this wasn't reachable from the
        // shipped UI, but nothing previously stopped a malformed/stale
        // request from splicing an entry into an arbitrary array position
        // relative to unrelated nodes (harmless to tree structure -- render
        // groups strictly by parentLocalId -- but a confusing sibling order
        // for the true siblings).
        if (diff[anchorIndex].parentLocalId !== input.parentLocalId) {
          throw new BadRequestException(`Diff entry ${input.anchorLocalId} is not a sibling under the requested parent`);
        }
        insertAt = input.placement === 'before' ? anchorIndex : anchorIndex + 1;
      } else {
        // No explicit sibling anchor -- land after the new parent's last
        // existing child (or at the end, for a root move) rather than ahead
        // of siblings that were already there.
        let lastSiblingIndex = -1;
        diff.forEach((e, i) => {
          if (e.parentLocalId === input.parentLocalId) lastSiblingIndex = i;
        });
        insertAt = lastSiblingIndex === -1 ? diff.length : lastSiblingIndex + 1;
      }
      diff.splice(insertAt, 0, entry);

      return diff;
    });
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
    const diff = (job.dryRunDiff as { action: string; type: string; localId: string; parentLocalId: string | null; excluded?: boolean; groundingScore?: number | null; qualityScore?: number | null; qualityConfidence?: string | null }[] | null) ?? [];
    return {
      // Excluded entries (and their whole subtree) must never count toward
      // "N new work items" -- confirm() itself skips them entirely (see
      // its own isExcluded), so this pre-confirm summary must match what
      // a real confirm() call would actually create/reuse/skip.
      ...summarizeDiffEntries(filterExcludedDiffEntries(diff)),
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
    const diff =
      (job.dryRunDiff as
        | {
            localId: string;
            parentLocalId: string | null;
            title: string;
            description: string;
            action: 'create' | 'reuse' | 'dedup_skip';
            existingAdoId: number | null;
          }[]
        | null) ?? [];
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
      // Same two-source resolution attachFigureToAdo's own doc comment
      // spells out: a reuse/dedup_skip parent's real ADO id is known
      // directly from existingAdoId (this job never created it, so it has
      // no CreatedItemMapping row at all) -- adoIdByLocalId alone only
      // covers a 'create' parent. Real bug this fixes: every created child
      // of a matched parent previously computed expectedParentAdoId as
      // null (a miss on adoIdByLocalId, silently defaulted), false-flagging
      // a correctly-written item as a parentId mismatch on every confirm.
      const parentEntry = entry.parentLocalId !== null ? diffByLocalId.get(entry.parentLocalId) : undefined;
      const expectedParentAdoId =
        entry.parentLocalId === null
          ? null
          : parentEntry && (parentEntry.action === 'reuse' || parentEntry.action === 'dedup_skip') && parentEntry.existingAdoId !== null
            ? parentEntry.existingAdoId
            : (adoIdByLocalId.get(entry.parentLocalId) ?? null);
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
  // touched here -- it's keyed by (sourceHash, areaPath), not
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
    // Write path -- hard-fail rather than falling back, same reasoning as
    // confirm()'s own adoProject check. Deliberately checked here, after
    // every more-specific 404/400 above: a caller asking about a
    // nonexistent entry/figure should see THAT error, not a generic
    // can't-write-at-all error that has nothing to do with what they asked.
    if (!job.adoProject) {
      throw new Error(`Job ${jobId} has no adoProject set -- cannot write to ADO without a resolved target project`);
    }

    // Task 6: figure's own name (Task 5), looked up from the SAME
    // figureDescriptions array getJob exposes to the frontend -- job was
    // already loaded above, no second query needed.
    const figureDescriptions =
      (job.figureDescriptions as { figureId: string; name: string | null }[] | null) ?? [];
    const figureName = figureDescriptions.find((d) => d.figureId === figureId)?.name ?? null;

    await this.mcpClient.uploadAttachment(
      adoId,
      buildFigureAttachmentFilename(figureId, figureName, figureFile.mimeType),
      Buffer.from(figureFile.bytes).toString('base64'),
      figureFile.mimeType,
      job.adoProject,
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
    // Atomic claim: findUnique+update below raced two concurrent confirms
    // (two tabs, a client timeout+retry, or an automation caller) past the
    // status check before either wrote 'writing', so both built identical
    // toCreate sets and both wrote the same items to ADO. updateMany's
    // where-clause is evaluated by Postgres as part of the single UPDATE,
    // so only the first caller's claim can ever match count: 1.
    const claim = await this.prisma.job.updateMany({
      where: { id, status: 'diff_ready' },
      data: { status: 'writing' },
    });
    if (claim.count === 0) {
      const job = await this.prisma.job.findUnique({ where: { id } });
      if (!job) throw new Error(`Job ${id} not found`);
      throw new Error(`Job ${id} is not in a confirmable state`);
    }
    const job = (await this.prisma.job.findUnique({ where: { id } }))!;
    // Previously confirm() had no JobEventsPublisher at all -- structurally
    // incapable of publishing anything, and JobDetail.tsx had no render
    // branch for status === 'writing' either (contrast with the explicit
    // 'pending' branch), so a job mid real-ADO-write showed NOTHING in the
    // UI for however long the create/link/trace-link phases below took.
    await this.jobEventsPublisher?.publish(id, 'writing');

    // Each diff entry carries its own sourceHash (per-node content hash),
    // NOT job.sourceHash (a whole-file hash) — see DryRunDiffEntry's doc
    // comment for why recording at job-level granularity silently broke
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
      // Carried through from ingestion (see DryRunDiffEntry.seCoverageRef).
      // Always null coming out of ingestion; a reviewer-editable manual
      // forward reference, written to ADO below (see
      // resolveSeCoverageRefField) only once an operator configures a real
      // candidate field name -- see se-coverage-ref-fields.ts's own doc
      // comment. Declared here for the SAME reason as figureIds' own doc
      // comment below: omitting a field here silently drops it on the
      // `{...diff[index]}`-style rewrites this file does elsewhere.
      seCoverageRef: string | null;
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
      const visited = new Set<string>();
      while (current) {
        if (current.excluded) return true;
        if (visited.has(current.localId)) return false;
        visited.add(current.localId);
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
    // Customer ID's real ref name is runtime-verified, not hardcoded
    // (docs/architecture.md's "Customer ID Field Resolution") — cached for
    // this confirm() call so discoverFields is called at most once. Only
    // ever resolved for the Requirement type; see the create-loop gate below.
    const customerIdFieldByType = new Map<string, string | null>();
    // Same runtime-verified, per-type, cached-once resolution for the source
    // traceability field (see resolveSourceRefField's doc comment).
    const sourceRefFieldByType = new Map<string, string | null>();
    // Same runtime-verified, per-type, cached-once resolution for the SE
    // coverage reference field (see resolveSeCoverageRefField's doc
    // comment) -- empty candidate list by default, so this resolves null
    // on every org until explicitly configured.
    const seCoverageRefFieldByType = new Map<string, string | null>();
    // Same pattern again for requirement classification -- see
    // resolveRequirementTypeField's own doc comment for why this ALSO
    // carries allowedValues, not just a field name.
    const requirementTypeFieldByType = new Map<string, { referenceName: string; allowedValues: string[] } | null>();
    // Requirements whose tags carried at least one category the resolved
    // field's real allowedValues couldn't represent -- collected across the
    // whole create loop into ONE warning below, matching this codebase's
    // established one-per-run dedup convention (see traceLinkFailures'
    // own warning below).
    const unmappableClassificationLocalIds: string[] = [];
    // Requirements that carried an extracted customerId but whose project
    // exposes no candidate Customer ID field at all (NEW-06 correction):
    // previously dropped silently, same "drop, don't tag" precedent as
    // sourceRef/seCoverageRef -- but unlike those two, a MISSING Customer ID
    // field is itself worth a reviewer's attention (it's the one traceability
    // value the customer spec calls out by name), so this is collected the
    // same way unmappableClassificationLocalIds is, into one combined
    // warning below rather than silence.
    const customerIdFieldMissingLocalIds: string[] = [];
    // Backs fieldsFor()'s per-confirm()-call memo of ado_discover_fields_detailed
    // -- shared by resolveCustomerIdField/resolveSourceRefField above (and
    // the classification field resolver) so each work-item type triggers at
    // most one ADO round-trip total, not one per field concept.
    const fieldsByType = new Map<string, Promise<{ referenceName: string; allowedValues: string[]; alwaysRequired: boolean }[]>>();
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
      // Explicit column, not areaPath.split('\\')[0] -- the derivation is a
      // correct VALUE but recomputing it per call site is exactly how this
      // project param went missing from several ADO write operations in the
      // first place (see Job.adoProject's own schema.prisma doc comment).
      // Hard-fail rather than falling back to any global/derived default:
      // this is the write path, and the migration backfilled every
      // historical row, so a null here means a genuinely inconsistent row,
      // not an ordinary one.
      if (!job.adoProject) {
        throw new Error(`Job ${id} has no adoProject set -- cannot write to ADO without a resolved target project`);
      }
      const project = job.adoProject;
      let realType: (type: string) => string = (type) => type;
      if (toCreate.length > 0) {
        await this.jobEventsPublisher?.publishNarration(id, {
          phase: 'writing',
          writeSubPhase: 'discover_types',
          blocksDone: 0,
          blocksTotal: toCreate.length,
          message: 'Resolving work-item type/field configuration for this project',
        });
        const workItemTypeCategories = await this.mcpClient.discoverWorkItemTypeCategories(project, credential);
        realType = (type: string): string => workItemTypeCategories[type as keyof typeof workItemTypeCategories] ?? type;
      }

      // Pre-resolve every distinct type's Customer ID field BEFORE the
      // concurrent create phase below -- discoverFields is idempotent, so a
      // race between concurrent creates of the same type would only be
      // wasteful (not incorrect), but resolving up front avoids that
      // entirely and keeps customerIdFieldByType's "at most once per type"
      // guarantee exact even under concurrency.
      // Requirement-only: Customer ID is a per-Requirement, document-derived
      // attribute (see ingestion/app/leveling/id_hierarchy.py) -- Epic/
      // Feature never carry one, and this gate is what stops them from ever
      // triggering a discoverFields round-trip or receiving the field/tag
      // below.
      for (const entry of toCreate) {
        if (entry.type === 'Requirement' && entry.customerId != null && !customerIdFieldByType.has(entry.type)) {
          customerIdFieldByType.set(entry.type, await this.resolveCustomerIdField(fieldsByType, realType(entry.type), project, credential));
        }
        if (entry.sourceRef != null && !sourceRefFieldByType.has(entry.type)) {
          sourceRefFieldByType.set(entry.type, await this.resolveSourceRefField(fieldsByType, realType(entry.type), project, credential));
        }
        // Requirement-only, same reasoning as Customer ID above.
        if (entry.type === 'Requirement' && entry.seCoverageRef != null && !seCoverageRefFieldByType.has(entry.type)) {
          seCoverageRefFieldByType.set(entry.type, await this.resolveSeCoverageRefField(fieldsByType, realType(entry.type), project, credential));
        }
        // Requirement-only, same reasoning as Customer ID above: classification
        // (entry.tags) is a per-Requirement attribute (see Phase 3's ingestion-side
        // enforcement) -- Epic/Feature never carry one and never trigger this
        // round-trip. BASELINE jobs never carry tags at all (tree_builder.py
        // never assigns them), so this is a no-op there without needing a
        // separate mode check.
        if (entry.type === 'Requirement' && (entry.tags?.length ?? 0) > 0 && !requirementTypeFieldByType.has(entry.type)) {
          requirementTypeFieldByType.set(entry.type, await this.resolveRequirementTypeField(fieldsByType, realType(entry.type), project, credential));
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
        // Requirement-only, per the gate above -- Epic/Feature never reach
        // here even when entry.customerId happens to be non-null (belt-and-
        // suspenders: ingestion's own enforcement pass already nulls it out
        // for non-Requirement nodes, see model.py's /level exit pass).
        // No System.Tags fallback when this org's process template exposes
        // no candidate field: a customer requirement's own source reference
        // is metadata, not a required field, and a free-text tag stamp
        // (`CustomerId:<value>`) turned out not to be a usable reference for
        // anyone reading it in ADO -- confirmed via a corrected audit
        // finding, not a guess. Left off entirely, same "traceability
        // metadata, not a hard failure" precedent resolveCustomerIdField's
        // own doc comment already establishes for the no-candidate-field case
        // -- but (NEW-06 correction) queued for the one combined warning
        // below instead of dropped in total silence: unlike sourceRef/
        // seCoverageRef, a missing Customer ID field is exactly the gap this
        // customer's own spec asks to be told about, not just tolerated.
        if (entry.type === 'Requirement' && entry.customerId != null) {
          const customerIdField = customerIdFieldByType.get(entry.type);
          if (customerIdField !== null && customerIdField !== undefined) {
            fields[customerIdField] = entry.customerId;
          } else {
            customerIdFieldMissingLocalIds.push(entry.localId);
          }
        }
        // Same "resolve a real field or drop it, never tag" rule as Customer
        // ID above -- NOT appended to System.Description either: that's
        // rejected elsewhere in this file as violating BASELINE's
        // verbatim-fidelity guarantee (see resolveSourceRefField's own doc
        // comment).
        if (entry.sourceRef != null) {
          const sourceRefField = sourceRefFieldByType.get(entry.type);
          if (sourceRefField !== null && sourceRefField !== undefined) {
            fields[sourceRefField] = JobsService.formatSourceRef(entry.sourceRef);
          }
        }
        // SE coverage reference -- same "resolve a real field or drop it,
        // never tag" rule. Resolves to null on every org until
        // SE_COVERAGE_REF_FIELD_CANDIDATES is explicitly configured (see
        // se-coverage-ref-fields.ts), so this is a no-op write path today
        // by design, not a bug -- the field stays reviewer-visible/editable
        // in the diff regardless.
        if (entry.type === 'Requirement' && entry.seCoverageRef != null) {
          const seCoverageRefField = seCoverageRefFieldByType.get(entry.type);
          if (seCoverageRefField !== null && seCoverageRefField !== undefined) {
            fields[seCoverageRefField] = entry.seCoverageRef;
          }
        }
        // Requirement classification -- same "resolve a real field or drop
        // it, never tag" rule as Customer ID/source ref above. Unlike those
        // two, a real resolved field doesn't always mean a value gets
        // written: entry.tags might carry only categories this org's real
        // picklist can't represent (e.g. "regulatory" has no CMMI
        // counterpart at all), in which case the field is deliberately left
        // at whatever ADO's own default already is (confirmed: this org's
        // process-template default, not something this code invents) and
        // the Requirement is queued for the one combined warning below.
        if (entry.type === 'Requirement' && (entry.tags?.length ?? 0) > 0) {
          const requirementTypeField = requirementTypeFieldByType.get(entry.type);
          if (requirementTypeField != null) {
            const value = JobsService.resolveClassificationValue(entry.tags ?? [], requirementTypeField.allowedValues);
            if (value !== null) {
              fields[requirementTypeField.referenceName] = value;
            } else {
              unmappableClassificationLocalIds.push(entry.localId);
            }
          }
        }
        const created = await this.mcpClient.createWorkItem(realType(entry.type), fields, project, credential);
        // Durable resume state (P4b): written immediately, not batched at
        // the end of the create loop, so a LATER item in this same
        // mapWithConcurrency batch failing doesn't lose the fact that THIS
        // one was already created -- the next confirm() retry will see this
        // row and skip re-creating it. Written BEFORE idempotencyService.record
        // -- record() can throw on its unique constraint (a concurrent
        // resubmit computing the same sourceHash), and this mapping is what
        // lets a retry recognize the ADO item already exists instead of
        // orphaning it with no local record at all.
        await this.prisma.createdItemMapping.upsert({
          where: { jobId_localId: { jobId: id, localId: entry.localId } },
          create: { jobId: id, localId: entry.localId, adoWorkItemId: created.id },
          update: { adoWorkItemId: created.id },
        });
        await this.idempotencyService.record(entry.sourceHash, job.areaPath, created.id);
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
          await this.ingestionClient.upsertDedupEntriesBatch(dedupUpsertItems, job.userId ?? undefined);
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
              // Only recorded in the in-memory list (used to build the
              // trace_link_write_failed warning below) once the durable row
              // is actually persisted -- pushing before the upsert would let
              // a bookkeeping-only failure (DB blip, or a non-Error
              // rejection making `(error as Error).message` undefined and
              // hitting the `error` column's NOT NULL constraint) leave the
              // warning promising a retry control that has no backing row.
              traceLinkFailures.push({ sourceLocalId: link.sourceLocalId, sourceAdoId, targetAdoId: link.targetAdoId, referenceName: link.referenceName });
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
          // Task 6: figureId -> name, built once from the SAME
          // figureDescriptions array getJob exposes -- `job` is already
          // in scope for this whole confirm() call, no second query.
          const figureNameByFigureId = new Map(
            ((job.figureDescriptions as { figureId: string; name: string | null }[] | null) ?? []).map((d) => [
              d.figureId,
              d.name,
            ]),
          );
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
                  buildFigureAttachmentFilename(figureId, figureNameByFigureId.get(figureId) ?? null, figureFile.mimeType),
                  Buffer.from(figureFile.bytes).toString('base64'),
                  figureFile.mimeType,
                  project,
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
    let updatedWarnings: (WarningRecord | string)[] =
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
    // Same reasoning as trace_link_write_failed above -- an ADO-org-specific
    // fact (this org's real RequirementType picklist doesn't include a
    // value for one of these tags) that only the orchestrator, not
    // ingestion, can know. Deliberately NOT one entry per Requirement --
    // one combined warning per confirm() run, matching this codebase's
    // established dedup convention (see DROPPED_BLOCKS/ZERO_NODES on the
    // ingestion side, and trace_link_write_failed immediately above).
    if (unmappableClassificationLocalIds.length > 0) {
      updatedWarnings = [
        ...updatedWarnings,
        {
          kind: 'classification_not_representable',
          severity: 'needs_review',
          nodeIds: Array.from(new Set(unmappableClassificationLocalIds)),
          detail: {},
          raw: `${unmappableClassificationLocalIds.length} Requirement(s) had a classification with no matching value in this project's Requirement Type field -- left at its default; review and set it manually if needed.`,
        } satisfies WarningRecord,
      ];
    }
    // NEW-06 correction: this project exposes no Customer ID field candidate
    // at all for the Requirement type, so the extracted value was left off
    // every affected item entirely (see the create loop above) -- flagged
    // here, once per confirm() run, same dedup convention as
    // classification_not_representable immediately above.
    if (customerIdFieldMissingLocalIds.length > 0) {
      updatedWarnings = [
        ...updatedWarnings,
        {
          kind: 'customer_id_field_not_configured',
          severity: 'needs_review',
          nodeIds: Array.from(new Set(customerIdFieldMissingLocalIds)),
          detail: {},
          raw: `${customerIdFieldMissingLocalIds.length} Requirement(s) had a Customer ID value that could not be written -- this project exposes no matching Customer ID field for the Requirement type. The value is preserved in req2ado's own review UI; configure CUSTOMER_ID_FIELD_CANDIDATES or add a matching field in Azure DevOps if this should be written there.`,
        } satisfies WarningRecord,
      ];
    }
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
        ...(updatedWarnings !== existingWarnings ? { warnings: updatedWarnings as any } : {}),
      },
    });
    await this.prisma.auditEntry.create({
      data: { jobId: id, message: `Job confirmed: ${createdCount} work item(s) created` },
    });
    return { status: 'succeeded', createdCount };
  }
}
