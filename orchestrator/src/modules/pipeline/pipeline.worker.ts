import { describeFailure } from './failure-reason';
import { JobResultCache, hashCatalog, isDegradedResult, kbVersionFor, type CachedResult } from './result-cache';
import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from './ingestion-http.client';
import type { OpenWebUiClientFactory } from '../llm/openwebui-client.factory';
import { resolveCrossJobTraceLinks, verifyExistingAdoIdsStillExist, type WarningRecord } from '../writeback/dry-run.service';
import type { DryRunService, DryRunTreeNode } from '../writeback/dry-run.service';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { BackfillService } from '../writeback/backfill.service';
import type { JobEventsPublisher } from './job-events.publisher';
import type { ProgressService } from './progress.service';
import type { McpClient, AdoRequestCredential } from './mcp.client';
import { DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES } from '../../config/customer-id-fields';
import type { AdoCredentialResolver } from '../auth/ado-credential.resolver';
import type { SettingsService } from '../settings/settings.service';

// A full area-path WIQL scan + batch fetch + embed + upsert (see
// BackfillService.backfillAreaPath) is real cost that shouldn't repeat on
// every single job against a busy, already-backfilled area path -- 24h is
// long enough that a manually-created ADO item still surfaces to the very
// next job submitted against that area path in any realistic same-day
// workflow, short enough that a stale scan self-heals within a day with
// zero manual action.
const AREA_PATH_BACKFILL_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// The primer now runs BEFORE /ingest (figures need document context during
// parsing, not just /level) -- there is no parsed `doc` yet to size num_ctx
// against. Per the design's explicit direction: don't reinvent a client-
// side size heuristic (page-count, raw-byte-count) here -- fixed at this
// deployment's real model ceiling (see the deleted PRIMER_NUM_CTX_BUCKETS'
// own comment: 32_768 is qwen2.5:32b-instruct/qwen3.6:35b's real native
// context window). A document whose real text exceeds this is an accepted,
// explicit tradeoff -- it silently loses primer enrichment (Open WebUI's
// own file-context handling may itself truncate or error; either way this
// call's fail-open catch below absorbs it) rather than failing the job.
const PRIMER_FIXED_NUM_CTX = 32_768;

// How long a computed primer stays cached in Redis by content hash -- long
// enough that a resubmitted/duplicate document within the same day never
// re-pays the real upload+chat cost, short enough that a stale cache entry
// self-heals within a day with zero manual action. Mirrors
// AREA_PATH_BACKFILL_STALE_AFTER_MS's own "throttle, don't disable" shape.
const PRIMER_CONTEXT_CACHE_TTL_SECONDS = 86_400;

// Hard clamp on the primer string, independent of maxTokens below. The
// prompt asks for "2-3 short sentences", but a model ignoring that
// instruction is a realistic failure mode, not an edge case -- and
// primerContext is threaded into /level as a URL query param
// (ingestion-http.client.ts), so an unbounded reply risks exceeding
// uvicorn/h11's request-line size limit and throwing a 400/431 from the
// /level call itself, OUTSIDE this block's own try/catch. That would fail
// the whole job on exactly the kind of soft LLM misbehavior this primer's
// fail-open design exists to absorb. A few hundred tokens' worth of
// characters is already generous for "document type/purpose/domain
// conventions" -- clamped here as the final backstop regardless of what
// maxTokens below actually bounds output to.
const PRIMER_CONTEXT_MAX_CHARS = 1000;

/**
 * Closes the "manually-created ADO items are invisible to dedup" gap for
 * THIS job's own areaPath, with no user action ever needed -- previously
 * BackfillService.backfillAreaPath was only reachable via a raw, un-linked
 * POST /backfill admin call (see backfill.controller.ts), so unless
 * someone manually curled it first, req2ado had zero knowledge of an item
 * an engineer created directly in the ADO UI. Throttled per area path
 * (AreaPathBackfill.lastBackfilledAt) so a repeat job against the same
 * area path doesn't re-pay the scan cost. Fail-open, same "must never fail
 * a SURVEY job" philosophy as every other optional pipeline enrichment --
 * a backfill failure only means this job (and any before the next
 * successful backfill) won't see manually-created items, never a reason
 * to fail the job itself.
 */
async function maybeBackfillAreaPath(
  prisma: PrismaClient,
  backfillService: BackfillService,
  areaPath: string,
  credential: AdoRequestCredential | undefined,
  userId?: string,
): Promise<void> {
  try {
    const existing = await prisma.areaPathBackfill.findUnique({ where: { areaPath } });
    const isStale = !existing || Date.now() - existing.lastBackfilledAt.getTime() > AREA_PATH_BACKFILL_STALE_AFTER_MS;
    if (!isStale) return;
    const result = await backfillService.backfillAreaPath(areaPath, credential, userId);
    if (result?.dedupUpsertFailed) {
      // The similarity index was not updated: do not record the area path as done, the next job tries again.
      // eslint-disable-next-line no-console -- worker process logging, not app logging
      console.error(`Area-path backfill for ${areaPath} could not update the dedup index; it will be retried by the next job`);
      return;
    }
    await prisma.areaPathBackfill.upsert({
      where: { areaPath },
      create: { areaPath, lastBackfilledAt: new Date() },
      update: { lastBackfilledAt: new Date() },
    });
  } catch (error) {
    // eslint-disable-next-line no-console -- worker process logging, not app logging
    console.error(`Area-path backfill failed for ${areaPath}:`, error);
  }
}

export interface PipelineJobInput {
  id: string;
  areaPath: string;
  // The ADO project this job writes into -- see Job.adoProject's own
  // schema.prisma doc comment. Nullable: an older job predating this column
  // (backfilled by migration, so should only be null for a genuinely
  // inconsistent row). Read-only/best-effort call sites below fall back to
  // undefined when null; write-path call sites hard-fail instead.
  adoProject: string | null;
  // The submitting user's stable ADO identity -- the Knowledge Base scope
  // key threaded into ingestionClient.level() below, kept separate from
  // areaPath (ADO write-back destination + dedup key only). Nullable: an
  // older/mocked job predating this field simply gets no KB grounding.
  userId: string | null;
  mode: 'baseline' | 'survey';
  fileBuffer: Buffer;
  filename: string;
  // Per-job LLM model override (SURVEY only -- BASELINE never calls an
  // LLM). Unset means "use whatever the orchestrator is configured with",
  // matching pre-model-selection behavior exactly.
  model?: string;
}

// Minimal shape the primer wiring block below actually needs from a Redis
// client -- deliberately NOT the full ioredis `Redis` type (whose `set`
// overloads carry a lot of surface this call site never touches), same
// "only the methods this consumer actually uses" spirit as every other
// narrowly-typed dep on PipelineWorkerDeps below.
interface PrimerCacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export interface PipelineWorkerDeps {
  ingestionClient: IngestionHttpClient;
  dryRunService: DryRunService;
  idempotencyService: IdempotencyService;
  prisma: PrismaClient;
  jobEventsPublisher: JobEventsPublisher;
  // Job transparency (B4): present only when LIVE_PROGRESS is on. Optional so
  // every existing caller and test is unaffected; with it absent this worker
  // behaves exactly as before.
  progressService?: ProgressService;
  mcpClient: McpClient;
  // See maybeBackfillAreaPath's own doc comment.
  backfillService: BackfillService;
  // Resolves the submitting user's vaulted ADO credential (by job.userId)
  // for the real-ADO-backend discovery calls below (discoverLinkTypes,
  // discoverFields) -- previously these ran with NO credential at all
  // (this worker is a separate BullMQ process with no request-scoped
  // header to read), silently 401ing against a real ADO backend and
  // falling back to an empty/seed catalog. The vault is what makes a
  // per-user credential available here at all.
  adoCredentialResolver: AdoCredentialResolver;
  // Phase 6c: whole-document AI context primer (see the primer wiring block
  // in runPipelineJob below). Both optional -- an older/mocked deps object
  // predating this field (every pre-existing test, the concurrency load
  // test) simply never computes a primer; primerContext stays undefined and
  // /level's own behavior is exactly what it always was before this field
  // existed. Also skipped whenever either is absent even for a real SURVEY
  // job, so a deployment can opt out entirely by just not wiring these two.
  //
  // A per-user, per-request-resolved factory, NOT a shared client instance
  // -- this worker is a BullMQ sandboxed process that can run jobs from
  // DIFFERENT users back to back (or, with sufficient concurrency, close
  // together); a single shared OpenWebUiClient would serve every job with
  // whichever user's token it was originally constructed from, silently
  // leaking one user's Open WebUI credential/model into another user's
  // job. See openwebui-client.factory.ts's own doc comment for the same
  // hazard this factory pattern exists to close everywhere else.
  openWebUiClientFactory?: OpenWebUiClientFactory;
  primerCacheRedis?: PrimerCacheRedis;
  // Stores a SURVEY job's parsed document and leveled tree so an identical rerun (same file, user, model, knowledge base and
  // release) returns the identical result; see result-cache.ts. Absent: nothing is cached (every older caller and test).
  resultCache?: JobResultCache;
  // LAST-RESORT fallback only, when job.model is unset (the wizard's
  // "Default" option) AND the per-user default can't be resolved (no
  // job.userId, no openWebUiClientFactory wired, or the user's profile was
  // removed after submit but before this ran). The PRIMARY source for
  // "job.model unset" is now the submitting user's own configured default
  // chat model, resolved via openWebUiClientFactory above (see
  // runPipelineJob's own model resolution) -- not this field. Before
  // per-user LLM credentials existed, this WAS the primary source (one
  // shared LLM_CHAT_MODEL env var); keeping it only as a fallback avoids a
  // real mismatch bug the per-user migration would otherwise introduce:
  // without it, job.model unset would resolve the REAL chat() call to the
  // user's own default (openwebui.client.ts's chat() already falls back to
  // its own per-user this.config.LLM_CHAT_MODEL) while sizing ingestion's
  // /level caps budget AND recording Job.model telemetry against a
  // DIFFERENT (stale, global) model name -- ingestion's _resolve_caps(name)
  // has no way to know what actually ran.
  defaultLlmModel: string;
  // Settings window (NEW-07) -- optional, same graceful-degrade convention
  // as openWebUiClient/primerCacheRedis above: an older/mocked deps object
  // predating this field simply never fetches a live threshold, and the
  // dedup-check call below passes no override, falling through to
  // check_for_duplicates.py's own unchanged 0.90 default.
  settingsService?: SettingsService;
  // Tesseract OCR language pack(s) for scanned-PDF OCR fallback (NEW-04),
  // e.g. 'heb+eng'. Optional, deployment-configured (OCR_LANGUAGES env var)
  // -- omitted for any deps object predating this field, and ingest() only
  // sends it on if it's actually set, so a deployment that never
  // configures it keeps ingestion's own unchanged 'eng' default.
  ocrLanguages?: string;
}

/**
 * Signals that JobsService.cancel() flipped this job's status to
 * 'cancelled' while the worker was already mid-run (the only case where a
 * cancel request can't just remove the still-queued BullMQ job outright --
 * see cancel()'s own doc comment). Thrown by assertNotCancelled at the
 * cooperative checkpoints below; the outer catch special-cases it so it
 * does NOT get overwritten back to 'failed' the way every other error does.
 */
class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = 'JobCancelledError';
  }
}

/**
 * Cooperative-cancellation checkpoint. There's no cross-process abort
 * channel to interrupt an in-flight ingestionClient.level() HTTP call (that
 * runs in this same sandboxed child process, not something a concurrent
 * cancel() request from the HTTP process can reach into) -- so cancellation
 * only takes effect the next time this function is called, not mid-call.
 * The one call site that matters most is right after level() resolves,
 * since that's the dominant wall-clock cost for a real SURVEY job.
 */
async function assertNotCancelled(prisma: PrismaClient, jobId: string): Promise<void> {
  const current = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (current?.status === 'cancelled') {
    throw new JobCancelledError(jobId);
  }
}

// Mirrors ingestion's Figure model (app/canonical/model.py, no field
// aliasing -- JSON keys are the literal Python field names) as returned
// inside the /ingest response's `figures` array. caption is null when
// vision is disabled/failed for that image (see main.py's
// _describe_figure), same convention as every other optional caption
// field in this pipeline.
interface LeveledFigure {
  id: string;
  caption: string | null;
  // Why a figure has no caption when the vision call itself failed (ingestion's Figure.caption_status).
  caption_status?: 'insignificant' | 'vision_failed' | null;
  // The author's own short title for this figure (parsed from a document
  // "Figure N: Title" caption line, or an LLM-generated fallback -- see
  // ingestion's Figure.name docstring) -- distinct from `caption`, which
  // is the vision model's prose description. Null when neither source
  // produced one.
  name: string | null;
}

interface LeveledTable {
  id: string;
  caption: string | null;
}

interface LeveledSourceRef {
  document_path: string;
  start_offset: number;
  end_offset: number;
  page: number | null;
  // Last page this node's folded content covers -- see ingestion's
  // WorkItemNode.source_ref.page_end docstring (shared/schemas/work-item-tree.schema.json).
  // Optional for the same backward-compat reason as the scoring fields
  // below: an older/mocked ingestion response predating this field must
  // not crash the mapping.
  page_end?: number | null;
  // Null when page/page_end came from the file's own real pagination,
  // 'rendered'/'interpolated' otherwise -- see ingestion's own docstring
  // for the full distinction. Optional for the same backward-compat
  // reason as page_end above.
  page_provenance?: string | null;
  // Root-first heading/section labels this ref was parsed from -- see
  // ingestion's WorkItemNode.source_ref.section_path docstring. Optional
  // for the same backward-compat reason as page_end above.
  section_path?: string[];
}

interface LeveledNode {
  local_id: string;
  parent_local_id: string | null;
  type: string;
  title: string;
  description: string;
  // Nullable, not just optional: ingestion's WorkItemNode.fidelity_hash is
  // "Required in BASELINE mode, null in SURVEY" (see
  // shared/schemas/work-item-tree.schema.json) -- this field was previously
  // typed as a required non-null `string` here, which was never actually
  // true for a SURVEY node. Found while wiring S10's generated WorkItemNode
  // type in (real type-honesty gap, not just a stale comment) -- harmless in
  // practice only because every read of this field below already falls back
  // via `??` (identity_hash ?? fidelity_hash at diffInputs, legacySourceHash
  // handled by dry-run.service.ts's own `?? undefined`), so this fixes the
  // type to match what the code already defensively assumed at runtime.
  fidelity_hash: string | null;
  // Distinct from fidelity_hash (drift detection only, see ingestion's
  // WorkItemNode.identity_hash doc comment) -- this is what the idempotency
  // lookup below actually keys on, so two nodes with byte-identical
  // description text but different source positions (a genuine verbatim
  // repeat in the source document) resolve as distinct work items rather
  // than the second silently reusing the first's ADO id. Optional for the
  // same backward-compat reason as the scoring fields below: an
  // older/mocked ingestion response predating this field must not crash
  // the mapping -- falls back to fidelity_hash at the diffInputs mapping
  // below, i.e. the pre-identity_hash behavior exactly.
  identity_hash?: string | null;
  customer_id: string | null;
  // Optional, same backward-compat reason as the scoring fields below --
  // an older/mocked ingestion response predating this field must not crash
  // the mapping. See ingestion's WorkItemNode.se_coverage_ref's own
  // docstring: always null out of ingestion, reviewer-supplied only.
  se_coverage_ref?: string | null;
  // SURVEY-only signals (see ingestion's WorkItemNode) -- null/[] for
  // BASELINE nodes and for any SURVEY node when scoring wasn't enabled.
  // Optional (not just nullable) because they didn't exist on this
  // response shape before this round -- an older/mocked ingestion response
  // in a test omitting them entirely must not crash the mapping below.
  grounding_score?: number | null;
  quality_score?: number | null;
  quality_issues?: string[];
  // Per-dimension 0-100 breakdown backing quality_score -- see ingestion's
  // QualityCategoryScores docstring (app.workitem.model). A dynamic
  // key->score map, NOT a fixed 5-field shape -- an org's own ingested KB
  // checklist can define its own category names (see dry-run.service.ts's
  // QualityCategoryScores, DiffTree.tsx, QualityGauge.tsx, all of which
  // already use Record<string, number>; this was the one stale holdout).
  // Optional for the same backward-compat reason as the other scoring
  // fields.
  quality_category_scores?: Record<string, number> | null;
  // Per-category citation text backing a SUBSET of quality_category_scores'
  // keys -- see ingestion's quality_category_checklist docstring
  // (app.workitem.model) and dry-run.service.ts's QualityCategoryChecklist.
  // Optional for the same backward-compat reason as the other scoring
  // fields.
  quality_category_checklist?: Record<string, string> | null;
  // SWEEP.md section 7's abstain channel -- see ingestion's
  // QualityConfidence docstring (app.workitem.model). Optional for the same
  // backward-compat reason as the other scoring fields.
  quality_confidence?: 'high' | 'medium' | 'low' | null;
  // Previously computed by ingestion (WorkItemNode.source_ref/tags) but
  // dropped here -- neither reached DryRunTreeNode nor any ADO field.
  // Optional for the same backward-compat reason as the scoring fields above.
  source_ref?: LeveledSourceRef | null;
  tags?: string[];
  child_type?: string | null;
  // SURVEY-only, LLM-judged relevance (see ingestion's WorkItemNode) --
  // optional for the same backward-compat reason as the scoring fields
  // above.
  figure_ids?: string[];
  // Ids of tables folded into/relevant to this node -- populated by all 4
  // node-building paths, not SURVEY-only (see ingestion's WorkItemNode.table_ids
  // docstring). A non-empty list means that table's HTML is already embedded
  // into `description`. Optional for the same backward-compat reason as
  // figure_ids above.
  table_ids?: string[];
  // Figures that folded into this node's span but produced no caption --
  // disjoint from figure_ids, a figure id appears in exactly one of the two
  // lists (see ingestion's WorkItemNode.uncaptioned_figure_ids docstring).
  // Optional for the same backward-compat reason as figure_ids above.
  uncaptioned_figure_ids?: string[];
  // SUBSET of uncaptioned_figure_ids -- the figures among that list the
  // vision model judged insignificant/decorative rather than a genuine
  // vision_failed case (see ingestion's WorkItemNode.insignificant_figure_ids
  // docstring). Optional for the same backward-compat reason as figure_ids
  // above.
  insignificant_figure_ids?: string[];
}

interface LeveledTraceLink {
  source_local_id: string;
  reference_name: string;
  display_name: string;
  target_kind: 'intraJob' | 'crossJob';
  target_local_id?: string;
  target_customer_id?: string;
  resolution_status: 'resolved' | 'unresolved' | 'pending';
}

// Mirrors ingestion's IntegrityWarning (shared/schemas/work-item-tree.schema.json,
// generated as @req2ado/shared-ts's IntegrityWarning) -- kept as a local,
// hand-annotated interface rather than importing the generated type
// directly, same convention LeveledNode/LeveledTraceLink above already use.
interface LeveledWarning {
  kind: string;
  severity: 'auto_fixed' | 'needs_review' | 'pipeline_issue';
  node_ids: string[];
  detail: Record<string, unknown>;
  raw: string;
}

/**
 * The actual pipeline glue that Phases 1-7 never built: chains the real
 * ingestion service (/ingest -> /level, Phase 1/4) into Phase 7's
 * DryRunService, persisting progress on the Job row (Phase 0's model,
 * unused until this task). `job.mode` is threaded straight through to
 * `ingestionClient.level()`, which defaults to 'baseline' — no BASELINE-path
 * behavior changes as a result.
 */
// job.model unset resolves to the SUBMITTING USER's own configured default
// chat model -- the same value openwebui.client.ts's chat() already falls
// back to internally, so ingestion's /level caps-sizing and Job.model
// telemetry can't drift from what actually ran (see PipelineWorkerDeps.
// defaultLlmModel's own doc comment for the mismatch this closes). Falls
// open to deps.defaultLlmModel only when per-user resolution genuinely
// isn't possible (no job.userId, no factory wired, or the profile vanished
// between submit and run) -- a real SURVEY job from a currently-logged-in
// user always has both, per the first-login configuration gate.
async function resolveDefaultChatModel(job: PipelineJobInput, deps: PipelineWorkerDeps): Promise<string> {
  if (job.userId && deps.openWebUiClientFactory) {
    try {
      const client = await deps.openWebUiClientFactory.getClientFor(job.userId);
      return client.chatModel;
    } catch {
      // Falls through to deps.defaultLlmModel below.
    }
  }
  return deps.defaultLlmModel;
}

// SURVEY-only: decides, before /ingest, whether the job's selected model can
// caption figures. Vision always uses the job's own model (there is no
// separate vision-model setting), so a text-only model must skip vision up
// front with a stated reason -- otherwise it either fails once per figure or
// (worse) answers without ever looking at the image. Fails open: if the
// model catalog can't be read, or the model isn't listed (the catalog hides
// presets/custom models), vision is attempted and ingestion's consecutive-
// failure breaker is the safety net.
async function resolveVisionPlan(
  job: PipelineJobInput,
  model: string,
  deps: PipelineWorkerDeps,
): Promise<{ skip: boolean; skipReason?: string }> {
  if (!job.userId || !deps.openWebUiClientFactory) {
    return { skip: false };
  }
  try {
    const client = await deps.openWebUiClientFactory.getClientFor(job.userId);
    const catalog = await client.listSelectableModels();
    const entry = catalog.find((candidate) => candidate.id === model);
    if (entry && !entry.vision) {
      return { skip: true, skipReason: 'model_not_vision_capable' };
    }
  } catch (error) {
    // eslint-disable-next-line no-console -- worker process logging, not app logging
    console.error(`Vision capability check failed for job ${job.id} (attempting vision anyway):`, error);
  }
  return { skip: false };
}

export async function runPipelineJob(
  job: PipelineJobInput,
  deps: PipelineWorkerDeps,
): Promise<ReturnType<DryRunService['diff']> extends Promise<infer T> ? T : never> {
  try {
    // Narrow but real race: cancel() couldn't remove the BullMQ job because
    // the worker had already picked it up (state 'active') the instant
    // before this line runs, so it flipped Job.status straight to
    // 'cancelled' instead. Without this check the line below would
    // immediately clobber that back to 'running'.
    await assertNotCancelled(deps.prisma, job.id);
    // job.model ?? resolveDefaultChatModel(...) -- always a concrete model
    // name, never undefined. Hoisted here (was resolved later, just before
    // the /level call) so the SAME binding can be persisted as Job.model
    // below -- DESIGN.md §11.2.3.b: written at pending->running, not
    // diff_ready, so a job that fails mid-/level (the longest, most
    // failure-prone stage) still records what it ran under, and a later
    // resubmit() has something real to read.
    const model = job.model ?? (await resolveDefaultChatModel(job, deps));
    // Real lifecycle: 'pending' (set on submit) -> 'running' (here) ->
    // 'diff_ready'/'failed'. Without this write the Job row sits at
    // 'pending' for the entire worker run, so the frontend's
    // status === 'running' gate (JobDetail.tsx's SSE subscription and
    // ProgressBanner) never activates.
    //
    // startedAt/model here are the ETA telemetry's write path (DESIGN.md
    // §11.2.3.b) -- model is null for BASELINE, which never calls an LLM at
    // all; `model` above is always a non-empty string regardless of mode
    // (resolveDefaultChatModel's own fallback chain never returns empty),
    // so without this guard every BASELINE row would falsely record a
    // model it never used.
    await deps.prisma.job.update({
      where: { id: job.id },
      data: { status: 'running', startedAt: new Date(), model: job.mode === 'survey' ? model : null },
    });
    await deps.jobEventsPublisher.publish(job.id, 'parse');
    // Resolved BEFORE ingest (rather than after, as before) so it's ready
    // for maybeBackfillAreaPath below without a second, redundant vault
    // lookup -- see PipelineWorkerDeps.adoCredentialResolver's doc comment.
    const credential = job.userId ? await deps.adoCredentialResolver.resolve(job.userId) : undefined;
    // mode threaded through so BASELINE never opens ingestion's vision-LLM
    // gate (see IngestionHttpClient.ingest's own doc comment) -- a real job
    // submission never sets skipVision, unlike /jobs/preview. job.id is
    // passed so ingestion can publish real parse-stage narration (figure
    // vision-captioning progress, parse summary) instead of the parse stage
    // being a silent black box.
    //
    // Whole-document AI context primer (Phase 6c): gives leveling -- and,
    // now that this block runs BEFORE /ingest, ingestion's own figure-vision
    // captioning during parsing too -- a short, model-authored orientation
    // (document type/purpose, the system it specifies, its domain phrasing
    // conventions) so per-branch/per-figure analysis isn't starting cold on
    // an unfamiliar document. SURVEY-only -- BASELINE never calls an LLM at
    // all (see defaultLlmModel's own doc comment above), so computing this
    // for a BASELINE job would only pay real upload/poll/chat cost for a
    // result ingestion's own baseline branch (main.py's /level route) never
    // reads.
    //
    // REQUIRES an Open WebUI-backed LLM_BASE_URL to work at all: the whole
    // mechanism is built on Open WebUI's own file-upload API
    // (POST/DELETE /api/v1/files/, plus the `files` chat extension --
    // openwebui.client.ts), which raw Ollama does not implement. Pointed at
    // raw Ollama (which IS this repo's k8s default -- see
    // k8s/01-configmap.yaml's LLM_BASE_URL) every upload attempt fails, so
    // the primer fails on every job and primerContext simply stays
    // undefined. That degradation is intentional and harmless, but it is
    // NOT silent any more -- see the catch block below.
    //
    // Two gates, both of which just leave primerContext undefined (/level's
    // exact pre-Phase-6c behavior) when they don't pass:
    //   1. SURVEY mode,
    //   2. both optional deps actually wired.
    // No document-size gate any more -- see PRIMER_FIXED_NUM_CTX's own
    // comment above for why (there is no parsed `doc` yet at this point to
    // size against, and per the design's explicit direction, a client-side
    // size heuristic isn't worth reinventing here).
    // Cached by content hash (model included in the key: the same
    // document primed under a different model could read differently) so a
    // resubmitted/duplicate document never re-pays the upload+chat cost.
    // Fail-open, same convention as linkTypeCatalog below -- a primer
    // failure (upload down, stuck/failed processing, malformed chat
    // response) must never block or fail the job; it only means leveling
    // proceeds without this one optional orientation hint, same as it
    // always has.
    let primerContext: string | undefined;
    const primerWarnings: WarningRecord[] = [];
    if (job.mode === 'survey' && deps.openWebUiClientFactory && deps.primerCacheRedis && job.userId) {
      const openWebUiClientFactory = deps.openWebUiClientFactory;
      const primerCacheRedis = deps.primerCacheRedis;
      try {
        // Resolved fresh per job from job.userId -- never cached/reused
        // across jobs at this call site itself (the factory has its own
        // internal per-user cache, keyed correctly). See
        // PipelineWorkerDeps.openWebUiClientFactory's own doc comment for
        // why a shared client instance here would be a credential leak.
        const openWebUiClient = await openWebUiClientFactory.getClientFor(job.userId);
        const contentHash = crypto.createHash('sha256').update(job.fileBuffer).digest('hex');
        const cacheKey = `primer:${model}:${contentHash}`;
        const cached = await primerCacheRedis.get(cacheKey);
        if (cached !== null) {
          primerContext = cached;
        } else {
          const fileId = await openWebUiClient.uploadFile(job.fileBuffer, job.filename);
          try {
            const processed = await openWebUiClient.pollFileProcessed(fileId, 60_000);
            if (processed) {
              // chatWithFullFileContext, NOT chat() -- chat() goes through
              // the OpenAI SDK, which always POSTs to
              // {baseURL}/chat/completions; with LLM_BASE_URL routed
              // through Open WebUI's Ollama-compat proxy, that path never
              // runs the native file-context middleware at all (confirmed
              // live and against Open WebUI v0.8.12 source -- see
              // chatWithFullFileContext's own doc comment). temperature/
              // seed are hardcoded inside that method to the same 0/0 this
              // primer has always needed: this text is (a) threaded into
              // every branch's analyze_section prompt, where sampled
              // wording shifts branch/node structure (the confirmed 74 vs
              // ~120 node variance), and (b) part of the figure-caption
              // cache KEY (ingestion main.py's _figure_caption_cache_key),
              // so a re-sampled primer after this primer cache's own TTL
              // would invalidate every figure's 7-day cache entry for the
              // SAME document.
              const askPrimer = (primerModel: string) => openWebUiClient.chatWithFullFileContext(
                'Read the attached document in full. In 2-3 short sentences, describe: the ' +
                  'document type and purpose, the system it specifies (if any), and the domain ' +
                  "conventions or phrasing style it uses. Do not list sections or definitions.",
                fileId,
                {
                  // Bounds worst-case latency AND output size -- same
                  // "structured extraction, not creative writing" reasoning
                  // OpenWebUiClient.vision()'s own maxTokens already applies
                  // to figure captions, here applied to a one-shot
                  // document-orientation summary. Without this, a model
                  // ignoring "2-3 short sentences" could produce a reply
                  // large enough to blow past /level's own query-string
                  // size limit (see PRIMER_CONTEXT_MAX_CHARS' own comment)
                  // -- this cap plus that clamp are two independent
                  // backstops against the same real risk.
                  maxTokens: 300,
                  // The job's own model (also part of the cache key above), not the client's configured default.
                  model: primerModel,
                  // Fixed at PRIMER_FIXED_NUM_CTX (see its own comment
                  // above for why) -- passed explicitly because Ollama
                  // otherwise runs at its own small default window
                  // regardless of prompt size and truncates the input with
                  // no error at all.
                  numCtx: PRIMER_FIXED_NUM_CTX,
                },
              );
              // The native file-context route only answers for models Open WebUI itself lists (claude-sonnet-4-6
              // came back "Model not found" there while working everywhere else). The primer is only an
              // orientation hint, so a job model it refuses falls back once to the client's configured model.
              let result;
              try {
                result = await askPrimer(model);
              } catch (primerError) {
                if (model === openWebUiClient.chatModel) throw primerError;
                // eslint-disable-next-line no-console -- worker process logging
                console.warn(`Whole-document primer refused model ${model} for job ${job.id}; retrying with ${openWebUiClient.chatModel}`);
                result = await askPrimer(openWebUiClient.chatModel);
              }
              primerContext = result.content?.trim().slice(0, PRIMER_CONTEXT_MAX_CHARS) || undefined;
              if (primerContext) {
                await primerCacheRedis.set(cacheKey, primerContext, 'EX', PRIMER_CONTEXT_CACHE_TTL_SECONDS);
              }
            }
          } finally {
            await openWebUiClient.deleteFile(fileId);
          }
        }
      } catch (error) {
        // Fail-open, same convention as linkTypeCatalog below -- a primer
        // failure must never block or fail the job.
        primerContext = undefined;
        // ...but it must not be INVISIBLE either. A systematically-failing
        // primer (most likely cause by far: LLM_BASE_URL pointing at raw
        // Ollama, which has no /api/v1/files/ endpoint at all -- see this
        // block's own comment above and k8s/01-configmap.yaml's default)
        // otherwise fails on every job forever with zero signal that the
        // capability isn't working. Logged with the job id, same
        // console.error convention every other fail-open path in this file
        // already uses.
        // eslint-disable-next-line no-console -- worker process logging, not app logging
        console.error(`Whole-document primer failed for job ${job.id} (leveling proceeds without it):`, error);
        primerWarnings.push({
          kind: 'primer_unavailable',
          severity: 'pipeline_issue',
          nodeIds: [],
          detail: {},
          raw: 'The whole-document overview could not be generated, so analysis ran without it. Items are otherwise unaffected.',
        });
      }
    }

    // Runs concurrently with the area-path backfill check (see
    // maybeBackfillAreaPath's own doc comment) -- an independent concern
    // with no data dependency on ingest, so there's no reason to pay its
    // cost serially on top of /ingest's own wall-clock time.
    // BASELINE never captions, so it keeps the exact pre-vision call shape.
    const visionPlan = job.mode === 'survey' ? await resolveVisionPlan(job, model, deps) : null;
    // An identical earlier SURVEY job (same file, user, model, knowledge base, release) already has its document and tree
    // stored: reuse them instead of asking the models again, so the result is identical. Any problem reading it is a miss.
    let cacheKey: string | null = null;
    let cached: CachedResult | undefined;
    // What the stored result depends on, besides the file: the KB documents, the ingestion build and the KB profile. Read twice: before
    // (to look up) and after the job (to store), because a profile built DURING the first job belongs in the key the result is stored under.
    const cacheKeyFor = async (): Promise<string | null> => {
      if (!deps.resultCache || job.mode !== 'survey' || !job.userId) return null;
      const kbVersion = await kbVersionFor(deps.prisma as never, job.userId);
      const scope = await deps.ingestionClient.cacheScope?.(job.userId);
      if (kbVersion === null || !scope) return null; // not readable: nothing is cached on a guess
      return deps.resultCache.keyFor({
        fileHash: crypto.createHash('sha256').update(job.fileBuffer).digest('hex'),
        userId: job.userId,
        model,
        mode: job.mode,
        kbVersion,
        ingestionVersion: scope.ingestion,
        profileVersion: scope.profile,
      });
    };
    if (deps.resultCache && job.mode === 'survey' && job.userId) {
      cacheKey = await cacheKeyFor();
      if (cacheKey !== null) {
        cached = await deps.resultCache.lookup(cacheKey);
        // eslint-disable-next-line no-console -- worker process logging
        if (cached) console.info(`Job ${job.id}: reusing the stored result of an identical earlier job`);
      }
    }
    const [doc] = await Promise.all([
      cached
        ? Promise.resolve(cached.doc as Awaited<ReturnType<typeof deps.ingestionClient.ingest>>)
        : deps.ingestionClient.ingest(
            job.fileBuffer,
            job.filename,
            visionPlan?.skip ?? false,
            job.mode,
            job.id,
            primerContext,
            deps.ocrLanguages,
            job.userId ?? undefined,
            ...(visionPlan ? [model, visionPlan.skipReason] : []),
          ),
      maybeBackfillAreaPath(deps.prisma, deps.backfillService, job.areaPath, credential, job.userId ?? undefined),
    ]);

    // Figure storage happens during /ingest, not /level -- a store()
    // failure there (main.py's _describe_figure_with_progress) can never
    // surface as a WorkItemTree IntegrityWarning (those only ever come from
    // /level's response), so it travels back via CanonicalDoc.
    // failed_figure_storage_ids instead and is synthesized into a
    // WarningRecord here, mirroring verificationWarnings' own
    // ado_verification_failed precedent further below (both are kinds the
    // orchestrator adds post-hoc, never present in ingestion's own closed
    // WarningKind vocabulary).
    const figureStorageWarnings: WarningRecord[] = [];
    if ((doc.failed_figure_storage_ids ?? []).length > 0) {
      const failedFigureIds = doc.failed_figure_storage_ids as string[];
      figureStorageWarnings.push({
        kind: 'figure_storage_failed',
        severity: 'pipeline_issue',
        nodeIds: [],
        detail: { figureIds: failedFigureIds },
        raw: `${failedFigureIds.length} figure(s) failed to store and will not be viewable/attachable: ${failedFigureIds.join(', ')}`,
      });
    }

    // A figure whose vision call failed has no caption and, until now, no signal anywhere (4 of 36 in a prod job).
    // Same orchestrator-added pattern as figureStorageWarnings above.
    const captionFailedIds = ((doc.figures ?? []) as LeveledFigure[])
      .filter((figure) => figure.caption_status === 'vision_failed')
      .map((figure) => figure.id);
    const figureCaptionWarnings: WarningRecord[] =
      captionFailedIds.length > 0
        ? [
            {
              kind: 'figure_caption_failed',
              severity: 'needs_review',
              nodeIds: [],
              detail: { figureIds: captionFailedIds },
              raw: `${captionFailedIds.length} figure(s) could not be described by the vision model and have no caption: ${captionFailedIds.join(', ')}`,
            },
          ]
        : [];

    // Captions/names are already here -- no ingestion/`/level` change
    // needed. 1-based index by array position matches the sequential
    // order main.py's per-request vision-call counter narrates figures
    // with (figure_index), which is what the frontend's
    // FigureDescriptions panel keys captions by.
    // Filter widened from "has a real caption" to "has a real caption OR a
    // name" (Task 5) -- a figure the document itself named via its own
    // "Figure N: Title" line (or an LLM title fallback) is now worth
    // showing even when vision produced no caption (disabled/failed).
    // figureId is now carried on each entry too, so jobs.service.ts's ADO
    // attachment-filename builder (Task 6) can look a figure's name up by
    // the SAME id JobFigureFile is keyed by, without a second Job column
    // -- figureDescriptions is already the one JSON field this data rides
    // in (see doc.figures.length vs figureDescriptions.length note below:
    // widening this filter does not change figureCount, which always
    // reads doc.figures.length directly). This is independent of
    // captionedFigureIds just below, which is a separate computation used
    // only for the prune-step guard and is unaffected by this filter.
    const figureDescriptions = ((doc.figures ?? []) as LeveledFigure[])
      .map((figure, index) => ({
        figureIndex: index + 1,
        figureId: figure.id,
        name: figure.name,
        caption: figure.caption,
        // Why there is no caption (vision failed vs. not worth describing); absent when there is a caption.
        ...(figure.caption_status ? { captionStatus: figure.caption_status } : {}),
      }))
      .filter((entry) => Boolean(entry.caption) || Boolean(entry.name));
    // Every figure with a real caption, regardless of node attachment --
    // used below to keep the prune step from deleting a figure this SAME
    // panel still promises an image for (see that comment for the full
    // story). Read straight off `figure.id`, not re-derived from
    // figureIndex arithmetic above -- two independent off-by-one traps
    // (figureIndex is 1-based, figure.id's own numeric suffix is 0-based)
    // already bit this exact reconciliation once during live debugging.
    const captionedFigureIds = ((doc.figures ?? []) as LeveledFigure[])
      .filter((figure) => Boolean(figure.caption))
      .map((figure) => figure.id);

    // Table.caption, keyed by the table's own id (unlike figureDescriptions'
    // array-position figureIndex) -- a "Table tN" chip (NodeDetailPanel.tsx)
    // already has the real tableId in hand from node.table_ids, so no
    // index-based translation is needed here. Same "nothing to show" rule
    // as figureDescriptions: a table with no real caption is simply absent,
    // not an entry with a null/empty caption.
    const tableDescriptions = ((doc.tables ?? []) as LeveledTable[])
      .filter((table) => Boolean(table.caption))
      .map((table) => ({ tableId: table.id, caption: table.caption as string }));

    // ingestion's /level call runs infer_hierarchy + generate_requirements
    // internally in one HTTP round trip with no intermediate signal back to
    // the orchestrator (SURVEY mode included) — see job-events.publisher.ts's
    // doc comment. The achievable stage granularity is therefore
    // parse -> infer_hierarchy_start -> generate_requirements_done ->
    // diff_ready, not the finer 4-point sequence the JobStage union's other
    // members would imply.
    // Discovered once per job (not per node/link) — mirrors
    // resolveCustomerIdField's per-confirm-call caching shape in
    // jobs.service.ts. Real ADO backends fall back to a seed catalog on
    // failure (mcp-ado-server's discoverLinkTypes); this call itself never
    // throws in practice, but if it somehow did, an empty catalog is the
    // correct degraded behavior — infer_trace_links just gets nothing to
    // choose from and every node's trace_links stays empty, never blocking
    // the rest of the job.
    //
    // credential already resolved above (before ingest/backfill).
    let linkTypeCatalog: { referenceName: string; name: string; semanticHint?: string }[] = [];
    try {
      linkTypeCatalog = await deps.mcpClient.discoverLinkTypes(job.adoProject ?? undefined, credential);
    } catch {
      linkTypeCatalog = [];
    }
    // Hierarchy-Forward/Reverse ("Child"/"Parent") are real ADO work-item
    // relation types, so they pass discoverLinkTypes' own
    // isWorkItemRelationType filter -- but trace-link inference exists to
    // find relationships the hierarchy DOESN'T already express (coverage,
    // testing, affects), not to re-discover parent-child structure that's
    // already fully captured via each node's parent_local_id. Without this
    // filter the model was redundantly proposing "Parent -> br0_n1" (etc.)
    // for nearly every node, cluttering the diff view with noise that
    // states nothing new. This is the ONLY consumer of this specific
    // catalog (confirmed: discoverLinkTypes has no other caller), so
    // filtering here is safe -- Hierarchy-Forward/Reverse remain legitimate
    // elsewhere (e.g. the actual ADO parent/child writeback).
    linkTypeCatalog = linkTypeCatalog.filter(
      (t) => t.referenceName !== 'System.LinkTypes.Hierarchy-Forward' && t.referenceName !== 'System.LinkTypes.Hierarchy-Reverse',
    );

    await deps.jobEventsPublisher.publish(job.id, 'infer_hierarchy_start');
    // job.userId (KB scope), NOT job.areaPath (ADO write-back destination --
    // see diffInputs[].areaPath and checkDuplicate below, both correctly
    // still using job.areaPath).
    // model resolved above (hoisted to the running-transition update) --
    // always a concrete model name, never undefined, so ingestion's
    // _resolve_caps can resolve real caps/tool-support instead of silently
    // falling back to the conservative unknown-model default for the
    // (common) "Default" wizard selection.
    // Follow ingestion's exact stage units for the duration of the leveling call
    // (observation only; tracking failures are swallowed inside the service).
    const stopProgress = await deps.progressService?.track(job.id);
    let levelResult: unknown;
    const catalogHash = hashCatalog(linkTypeCatalog);
    try {
      if (cached && cached.catalogHash === catalogHash) {
        levelResult = cached.tree;
      } else {
        levelResult = await deps.ingestionClient.level(doc, job.mode, job.userId ?? undefined, linkTypeCatalog, model, job.id, primerContext);
        const leveled = levelResult as { warnings?: { kind: string }[] };
        const degraded = primerWarnings.length > 0 || isDegradedResult(leveled?.warnings, doc.figures as { caption_status?: string }[] | undefined);
        if (deps.resultCache && cacheKey && !degraded) {
          const storeKey = (await cacheKeyFor()) ?? null; // after the job: a profile it built is now part of the scope
          if (storeKey) await deps.resultCache.save(storeKey, { doc, tree: levelResult, catalogHash });
        }
      }
    } finally {
      await stopProgress?.();
    }
    const tree = levelResult as {
      nodes: LeveledNode[];
      warnings?: LeveledWarning[];
      kb_citations?: { source_file: string; similarity: number; relevance: string }[];
      trace_links?: LeveledTraceLink[];
      excluded_figure_ids?: string[];
      excluded_table_ids?: string[];
    };
    await deps.jobEventsPublisher.publish(job.id, 'generate_requirements_done');
    // The dominant wall-clock cost (15-40+ min for SURVEY) just finished --
    // this is the most valuable checkpoint to notice a cancel() request
    // that arrived while it was running.
    await assertNotCancelled(deps.prisma, job.id);

    const traceLinksByLocalId = new Map<string, DryRunTreeNode['traceLinks']>();
    for (const link of tree.trace_links ?? []) {
      const existing = traceLinksByLocalId.get(link.source_local_id) ?? [];
      existing.push({
        sourceLocalId: link.source_local_id,
        referenceName: link.reference_name,
        displayName: link.display_name,
        targetKind: link.target_kind,
        targetLocalId: link.target_local_id,
        targetCustomerId: link.target_customer_id,
        resolutionStatus: link.resolution_status,
      });
      traceLinksByLocalId.set(link.source_local_id, existing);
    }

    const diffInputs: DryRunTreeNode[] = tree.nodes.map((node) => {
      // identity_hash is what actually distinguishes two nodes with
      // byte-identical description text (see LeveledNode's own doc
      // comment) -- fidelity_hash alone would silently collapse them via
      // the idempotency lookup below. Falls back to fidelity_hash for an
      // older/mocked response predating identity_hash, matching the exact
      // pre-identity_hash behavior for that case.
      //
      // fidelity_hash is genuinely null for every current SURVEY node (see
      // shared/schemas/work-item-tree.schema.json's own doc comment) -- this
      // fallback is only ever meant to catch a legacy/pre-identity_hash
      // BASELINE response, where fidelity_hash was always required. Both
      // being absent means ingestion sent a node this pipeline cannot
      // idempotency-key at all -- fail loudly rather than let `undefined`
      // silently reach DryRunTreeNode.sourceHash (required, non-null) and
      // corrupt the idempotency lookup below.
      const sourceHash = node.identity_hash ?? node.fidelity_hash;
      if (sourceHash == null) {
        throw new Error(`Node ${node.local_id} has neither identity_hash nor fidelity_hash -- cannot compute a stable sourceHash`);
      }
      return {
        localId: node.local_id,
        parentLocalId: node.parent_local_id,
        type: node.type,
        title: node.title,
        description: node.description,
        sourceHash,
        // Migration-safety fallback for IdempotencyService.lookup -- see
        // DryRunTreeNode.legacySourceHash's own doc comment. Only meaningful
        // when identity_hash is actually present and differs from
        // fidelity_hash; dry-run.service.ts's `?? undefined` handles the
        // null case for an older/mocked node shape.
        legacySourceHash: node.fidelity_hash,
        customerId: node.customer_id,
        // Always null coming out of ingestion (see WorkItemNode.
        // se_coverage_ref's own docstring) -- carried through purely so a
        // reviewer's later edit (editDiffEntry) has somewhere to persist
        // to on the SAME diff entry, exactly like customerId itself.
        seCoverageRef: node.se_coverage_ref ?? null,
        areaPath: job.areaPath,
        groundingScore: node.grounding_score ?? null,
        qualityScore: node.quality_score,
        qualityIssues: node.quality_issues,
        qualityCategoryScores: node.quality_category_scores,
        qualityCategoryChecklist: node.quality_category_checklist,
        // node.quality_confidence is typed as the literal union on LeveledNode
        // above, but that interface is only a compile-time label on parsed
        // ingestion JSON -- nothing narrows it at runtime. An unexpected
        // string here (e.g. differently-cased) must fall back to null rather
        // than silently pass through as a false-typed literal that
        // isFlaggedDiffEntry would then read as "not low" -- a silently
        // unflagged item.
        qualityConfidence:
          node.quality_confidence === 'high' || node.quality_confidence === 'medium' || node.quality_confidence === 'low'
            ? node.quality_confidence
            : null,
        sourceRef: node.source_ref
          ? {
              documentPath: node.source_ref.document_path,
              startOffset: node.source_ref.start_offset,
              endOffset: node.source_ref.end_offset,
              page: node.source_ref.page,
              pageEnd: node.source_ref.page_end ?? null,
              pageProvenance: node.source_ref.page_provenance ?? null,
              sectionPath: node.source_ref.section_path ?? [],
            }
          : null,
        tags: node.tags ?? [],
        childType: node.child_type,
        traceLinks: traceLinksByLocalId.get(node.local_id) ?? [],
        figureIds: node.figure_ids ?? [],
        tableIds: node.table_ids ?? [],
        uncaptionedFigureIds: node.uncaptioned_figure_ids ?? [],
        insignificantFigureIds: node.insignificant_figure_ids ?? [],
      };
    });

    // Ingestion stored a JobFigureFile row for EVERY figure at ingest time
    // (relevance wasn't known yet then) -- now that the real tree exists,
    // prune down to only the figures some node's figureIds/uncaptionedFigureIds
    // actually references, UNION the figures the job-wide figureDescriptions
    // panel still shows a caption for (see JobFigureFile's own Prisma model
    // comment for the full lifecycle). The figureDescriptions union is a
    // real, confirmed fix, not defensive padding: a figure Stage 2 mapping
    // excludes from every node (decorative scope, see excludedFigureIds)
    // is correctly absent from both node-level lists, but figureDescriptions
    // itself is scoped document-wide and keeps showing its real caption
    // regardless of exclusion -- without this, that panel's own promise
    // ("full vision-model output for each embedded figure") broke for
    // exactly the excluded-but-captioned figures: a real, permanent 404 on
    // a fully-completed job, reproduced live, not the known SSE-vs-storage
    // race the retry budget already covers. Best-effort: a failure here
    // must never fail the whole job over what's purely a storage-cost
    // cleanup step -- a leftover row just means one extra figure sticks
    // around until confirm() deletes it on successful attachment upload,
    // or the retention sweep's safety net eventually reclaims it.
    try {
      const referencedFigureIds = [
        ...new Set([
          ...diffInputs.flatMap((node) => [...(node.figureIds ?? []), ...(node.uncaptionedFigureIds ?? [])]),
          ...captionedFigureIds,
        ]),
      ];
      // Real, confirmed bug: Prisma's `notIn: []` matches EVERY row, not
      // zero, so a job where NO node references any figure at all
      // (referencedFigureIds === []) would delete ALL of this job's stored
      // figure bytes instead of leaving them untouched. Guard explicitly
      // rather than relying on notIn's empty-array semantics happening to
      // mean "match nothing" -- it means the opposite.
      if (referencedFigureIds.length > 0) {
        await deps.prisma.jobFigureFile.deleteMany({
          where: { jobId: job.id, figureId: { notIn: referencedFigureIds } },
        });
      }
    } catch (error) {
      console.error(`JobFigureFile prune failed for job ${job.id}:`, error);
    }

    const customerIdFieldCandidates = DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES;
    // Hoisted above the crossJob-only if-block below so the SAME value is
    // also in scope for queryIds's project param further down -- both
    // operate on this job's ADO project, not just the Requirement-category
    // resolution. job.adoProject (not areaPath.split('\\')[0]) -- see
    // Job.adoProject's own schema.prisma doc comment. Every use in this
    // function is fail-open/best-effort (discovery for the diff, not an
    // actual ADO write -- that happens later in confirm()), so this falls
    // back to undefined rather than hard-failing on a null value; the
    // hard-fail belongs at the actual write path.
    const project = job.adoProject ?? undefined;
    // Cross-job trace-link targets are always Requirement-CATEGORY items in
    // practice (System/Customer requirement pairs — the driving use case),
    // so a single discoverFields call is enough; if this assumption stops
    // holding, thread the actual target type through instead of hardcoding
    // it here. Confirmed real bug (fixed here): 'Requirement' is req2ado's
    // internal category label, not necessarily the real ADO type name for
    // this project's process template (Agile's is "User Story", Scrum's is
    // "Product Backlog Item") -- resolved via the same
    // discoverWorkItemTypeCategories concept jobs.service.ts's confirm()
    // uses at write time.
    // Same vaulted credential as discoverLinkTypes above.
    let resolvedCustomerIdField: string | null = null;
    if ((tree.trace_links ?? []).some((l) => l.target_kind === 'crossJob')) {
      const realRequirementType = await deps.mcpClient
        .discoverWorkItemTypeCategories(project, credential)
        .then((categories) => categories.Requirement)
        .catch(() => 'Requirement');
      const availableFields = await deps.mcpClient.discoverFields(realRequirementType, project, credential).catch(() => [] as string[]);
      resolvedCustomerIdField =
        customerIdFieldCandidates.find((candidate) => availableFields.includes(candidate)) ?? null;
    }

    // Always run the near-duplicate check -- deciding whether a work item
    // already exists under this area path is a required step of every
    // ingestion, not an opt-in extra a user has to remember to tick. A
    // first-time area path simply has nothing indexed yet, so every check
    // legitimately comes back "not a duplicate" at negligible cost (one
    // embed call per node, already fail-open on any dedup-service error --
    // see dryRunService.diff's own doc comment). (This used to be gated on
    // a now-removed Job.followUp flag, WID 300567 -- the flag was never
    // wired to anything real; this check has always run unconditionally.)
    // Previously this whole burst (confirmed live: ~543 nodes on a real
    // job) published NO progress signal at all -- 'diff_ready' was the very
    // next event after 'generate_requirements_done', so a job could sit
    // silent for however long the idempotency/dedup-check burst took with
    // no way to tell it from a stall.
    await deps.jobEventsPublisher.publish(job.id, 'dedup_check');
    // Fetched once per job, not per node -- a live-editable value read
    // hundreds of times in a tight loop would be needless DB load for a
    // number that can't meaningfully change mid-job. Fail-open (same
    // convention as every other dedup-adjacent call in this function): a
    // Settings lookup failure must never fail a job, it just means this
    // job runs against ingestion's own unchanged 0.90 default, identical to
    // before this feature existed.
    const dedupThreshold = await deps.settingsService?.get().then(
      (settings) => settings.dedupThreshold,
      () => undefined,
    );
    // Job transparency (B9b): passed only when live progress is configured, so
    // every existing call keeps exactly its previous arguments.
    const liveJobIdArg: [string] | [] = deps.progressService ? [job.id] : [];
    const diff = await deps.dryRunService.diff(
      diffInputs,
      deps.idempotencyService,
      (text, title, areaPath) =>
        deps.ingestionClient.checkDuplicate(text, title, areaPath, dedupThreshold, job.userId ?? undefined, ...liveJobIdArg),
      (completed, total, currentTitle) => {
        void deps.progressService?.record(job.id, { stage: 'dedup', unit: 'items', done: completed, total });
        void deps.jobEventsPublisher.publishNarration(job.id, {
          phase: 'dedup_check',
          blocksDone: completed,
          blocksTotal: total,
          currentTitle,
          message: `Checking for existing/duplicate work items -- ${completed} of ${total} (${currentTitle})`,
        });
      },
    );

    // Real gap this closes (confirmed live): a reuse/dedup_skip match is
    // recorded once and trusted forever after, even once the ADO item it
    // points at is deleted directly in ADO -- see verifyExistingAdoIdsStillExist's
    // own doc comment. Runs BEFORE the crossJob trace-link resolution below
    // so a stale match is already downgraded to 'create' in what that step
    // (and the Prisma write after it) both operate on.
    const verificationWarnings: WarningRecord[] = [];
    const verifiedDiff = await verifyExistingAdoIdsStillExist(
      diff,
      (ids) => deps.mcpClient.getWorkItemsBatch(ids, credential),
      (message) => {
        // eslint-disable-next-line no-console -- operational visibility for a best-effort verification pass, not app logging
        console.error(`verifyExistingAdoIdsStillExist failed for job ${job.id}:`, message);
        verificationWarnings.push({ kind: 'ado_verification_failed', severity: 'pipeline_issue', nodeIds: [], detail: {}, raw: message });
      },
    );
    // Best-effort cleanup: a 'reuse' (exact-hash IdempotencyMapping) match
    // that just got downgraded means that row now points at a dead ADO
    // id -- delete it so this SAME node doesn't match the same stale id
    // again on every future job against this area path. Failure here must
    // never fail the job itself; the downgrade to 'create' has already
    // happened either way.
    const staleReuseIds = diff
      .filter((entry, i) => entry.action === 'reuse' && verifiedDiff[i].action === 'create')
      .map((entry) => entry.existingAdoId as number);
    for (const staleId of staleReuseIds) {
      try {
        await deps.idempotencyService.deleteByAdoWorkItemId(staleId);
      } catch (error) {
        // eslint-disable-next-line no-console -- operational visibility for a best-effort cleanup path, not app logging
        console.error(`Failed to delete stale IdempotencyMapping row for ADO id ${staleId}:`, error);
      }
    }

    // Same cleanup for a 'dedup_skip' (Chroma similarity) match that just
    // got downgraded -- previously had no equivalent per-id delete path
    // (confirmed live: a deleted-in-ADO item kept surfacing as a dedup
    // match on every subsequent job against the same area path, because
    // its Chroma entry outlived the ADO item it pointed at).
    const staleDedupSkipIds = diff
      .filter((entry, i) => entry.action === 'dedup_skip' && verifiedDiff[i].action === 'create')
      .map((entry) => entry.existingAdoId as number);
    for (const staleId of staleDedupSkipIds) {
      try {
        await deps.ingestionClient.deleteDedupEntry(String(staleId), job.areaPath);
      } catch (error) {
        // eslint-disable-next-line no-console -- operational visibility for a best-effort cleanup path, not app logging
        console.error(`Failed to delete stale dedup vector entry for ADO id ${staleId}:`, error);
      }
    }

    const resolvedDiff =
      resolvedCustomerIdField !== null
        ? await Promise.all(
            verifiedDiff.map(async (entry) => ({
              ...entry,
              traceLinks: entry.traceLinks
                ? await resolveCrossJobTraceLinks(entry.traceLinks, async (customerId) =>
                    deps.mcpClient.queryIds({ [resolvedCustomerIdField as string]: customerId }, project, credential),
                  )
                : entry.traceLinks,
            })),
          )
        : verifiedDiff;

    // Third and final cooperative-cancellation checkpoint. The two earlier
    // checkpoints (before ingest(), right after level()) do not cover the
    // dedup/verification/trace-link-resolution tail that runs between them
    // and this write (dryRunService.diff's embed-based dedup checks,
    // verifyExistingAdoIdsStillExist's ADO batch lookup, the stale-mapping
    // cleanup loops, resolveCrossJobTraceLinks' cross-job WIQL queries) --
    // real jobs have seen a 543-node embed round-trip in this window alone.
    // Without this check, a cancel() landing anywhere in that tail (a user
    // action, or the automated stale-job watchdog) is silently overwritten
    // by the unconditional write below, resurrecting a job the user already
    // cancelled. The existing catch block's JobCancelledError handling
    // (does not overwrite status, writes an audit entry, publishes
    // 'cancelled') already covers this throw correctly -- no other change
    // needed.
    await assertNotCancelled(deps.prisma, job.id);

    // `resolvedDiff` is a plain JSON-serializable array of DryRunDiffEntry;
    // cast past Prisma's generated InputJsonValue type (its structural check
    // does not resolve concrete array-of-interface types against the JSON
    // union even though the runtime value is valid JSON).
    await deps.prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'diff_ready',
        dryRunDiff: resolvedDiff as any,
        warnings: [
          ...(tree.warnings ?? []).map(
            (w): WarningRecord => ({ kind: w.kind, severity: w.severity, nodeIds: w.node_ids, detail: w.detail, raw: w.raw }),
          ),
          ...verificationWarnings,
          ...figureStorageWarnings,
          ...figureCaptionWarnings,
          ...primerWarnings,
        ] as any,
        kbCitations: (tree.kb_citations ?? []).map((c) => ({
          sourceFile: c.source_file,
          similarity: c.similarity,
          relevance: c.relevance,
        })) as any,
        figureDescriptions: figureDescriptions as any,
        tableDescriptions: tableDescriptions as any,
        // Doc-wide figure/table ids the mapping stage judged decorative/
        // irrelevant, or that failed mapping -- NOT an exhaustive
        // accounting of every table/figure not attached to a node (see
        // Job.excludedTableIds' schema.prisma doc comment for the
        // EMPTY_TABLE_CONTENT caveat).
        excludedFigureIds: (tree.excluded_figure_ids ?? []) as any,
        excludedTableIds: (tree.excluded_table_ids ?? []) as any,
        // ETA telemetry write path, part 2 (DESIGN.md §11.2.3.b). Real
        // pipeline completion, independent of whether/how a human later
        // reviews it -- diffReadyAt is deliberately NOT set in confirm()
        // or reject(). doc.figures.length (every figure), not
        // figureDescriptions.length (already filtered to captioned-or-named
        // figures above) -- must match the same quantity
        // jobs.controller.ts's preview() counts, or the ETA fit trains on
        // a different quantity than it predicts against. Part B's
        // excludedFigureIds/excludedTableIds above do NOT belong in this
        // subtraction either, for the same reason: an excluded figure was
        // still parsed, still captioned by the vision model, and still
        // carried through the mapping call that excluded it, so it cost
        // what every other figure cost. Netting it out here would make
        // figureCount mean something preview() cannot compute.
        blockCount: (doc.blocks ?? []).length,
        figureCount: (doc.figures ?? []).length,
        tableCount: (doc.tables ?? []).length,
        cellCount: (doc.tables ?? []).reduce((n, t) => n + (t.cells ?? []).reduce((rn, row) => rn + row.length, 0), 0),
        diffReadyAt: new Date(),
      },
    });
    await deps.prisma.auditEntry.create({
      data: {
        jobId: job.id,
        message: `Dry-run diff ready: ${resolvedDiff.length} node(s), ${resolvedDiff.filter((e) => e.action === 'create').length} to create`,
      },
    });

    // One structured, durable row per skipped duplicate (see schema.prisma's
    // DedupSkipAudit doc comment) -- distinct from the free-text AuditEntry
    // above, and from the in-memory dedupSkipCount the frontend derives from
    // dryRunDiff. createMany is a no-op for an empty array (no dedup_skip
    // entries in this diff), matching upsertDedupEntriesBatch's own
    // no-call-for-empty-input convention elsewhere in this pipeline.
    const dedupSkips = resolvedDiff.filter(
      (e) => e.action === 'dedup_skip' && e.existingAdoId !== null && e.similarity !== null,
    );
    if (dedupSkips.length > 0) {
      await deps.prisma.dedupSkipAudit.createMany({
        data: dedupSkips.map((e) => ({
          jobId: job.id,
          localId: e.localId,
          similarity: e.similarity as number,
          existingAdoId: e.existingAdoId as number,
        })),
      });
    }

    // The 100% progress event goes out BEFORE diff_ready: the browser event
    // stream closes on diff_ready, so anything published after it is never seen
    // (verified against the real stack: progress otherwise ends at 99).
    await deps.progressService?.finish(job.id);
    await deps.jobEventsPublisher.publish(job.id, 'diff_ready');
    return resolvedDiff;
  } catch (error) {
    if (error instanceof JobCancelledError) {
      // Status is already 'cancelled' (set by JobsService.cancel(), which
      // is what threw this via assertNotCancelled) -- must NOT be
      // overwritten to 'failed' the way every other error below is.
      await deps.prisma.auditEntry.create({
        data: { jobId: job.id, message: 'Pipeline stopped: job was cancelled' },
      });
      await deps.jobEventsPublisher.publish(job.id, 'cancelled');
      return [];
    }
    // Guard against a DIFFERENT error (not JobCancelledError) throwing from
    // the tail after a concurrent cancel() already wrote status:
    // 'cancelled' -- an unconditional write here would resurrect the job to
    // 'failed', the same symptom the JobCancelledError branch above exists
    // to prevent, just reached via the error path instead of the success
    // path (SWEEP.md section 8a). `count === 0` means the row was already
    // 'cancelled' when this ran.
    const failureWrite = await deps.prisma.job.updateMany({
      where: { id: job.id, status: { not: 'cancelled' } },
      data: { status: 'failed' },
    });
    if (failureWrite.count === 0) {
      // Do not rethrow: this runs inside a BullMQ sandboxed processor
      // (pipeline.processor.ts). A thrown error here would surface as a
      // spurious BullMQ job failure for a job that's actually fine (it's
      // cancelled, not failed) -- and if retries are ever configured on
      // this queue, rethrowing would also re-run an already-cancelled job.
      await deps.prisma.auditEntry.create({
        data: {
          jobId: job.id,
          message: `Pipeline error occurred after cancellation, job remains cancelled: ${describeFailure(error)}`,
        },
      });
      return [];
    }
    await deps.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Pipeline failed: ${describeFailure(error)}` },
    });
    await deps.jobEventsPublisher.publish(job.id, 'failed');
    throw error;
  }
}
