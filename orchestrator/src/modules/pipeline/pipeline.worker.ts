import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from './ingestion-http.client';
import type { OpenWebUiClient } from '../llm/openwebui.client';
import { resolveCrossJobTraceLinks, verifyExistingAdoIdsStillExist, type WarningRecord } from '../writeback/dry-run.service';
import type { DryRunService, DryRunTreeNode } from '../writeback/dry-run.service';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { BackfillService } from '../writeback/backfill.service';
import type { JobEventsPublisher } from './job-events.publisher';
import type { McpClient, AdoRequestCredential } from './mcp.client';
import { DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES } from '../../config/customer-id-fields';
import type { AdoCredentialResolver } from '../auth/ado-credential.resolver';

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
): Promise<void> {
  try {
    const existing = await prisma.areaPathBackfill.findUnique({ where: { areaPath } });
    const isStale = !existing || Date.now() - existing.lastBackfilledAt.getTime() > AREA_PATH_BACKFILL_STALE_AFTER_MS;
    if (!isStale) return;
    await backfillService.backfillAreaPath(areaPath, credential);
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
  // The submitting user's stable ADO identity -- the Knowledge Base scope
  // key threaded into ingestionClient.level() below, kept separate from
  // areaPath (ADO write-back destination + dedup key only). Nullable: an
  // older/mocked job predating this field simply gets no KB grounding.
  userId: string | null;
  customerId: string | null;
  mode: 'baseline' | 'survey';
  // True when this job ingests a follow-up document against requirements
  // already ingested under the same area path -- gates whether the diff()
  // call below runs the dedup-similarity check at all (see Job.followUp's
  // schema.prisma doc comment). Defaults to false when constructing the
  // BullMQ payload (see pipeline-worker.main.ts/jobs.service.ts), matching
  // an older/mocked job predating this field: no dedup, same as any other
  // first-time ingestion.
  followUp?: boolean;
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
  openWebUiClient?: OpenWebUiClient;
  primerCacheRedis?: PrimerCacheRedis;
  // The orchestrator's own configured LLM_CHAT_MODEL -- when job.model is
  // unset (the wizard's "Default" option), this worker previously sent
  // `undefined` straight through to ingestion's /level route, and
  // ingestion's _resolve_caps(None) has NO way to know what "the
  // orchestrator's default" actually resolves to -- it silently fell back
  // to the smallest/most-conservative caps (supports_tools=False, a 28k
  // token budget) even for a model that genuinely supports tool-calling
  // and a much larger context. Resolving to this concrete name here (see
  // runPipelineJob's own model resolution below) means ingestion always
  // receives a real, known model string for a SURVEY job.
  defaultLlmModel: string;
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
    // job.model ?? deps.defaultLlmModel (see PipelineWorkerDeps.defaultLlmModel's
    // doc comment) -- always a concrete model name, never undefined. Hoisted
    // here (was resolved later, just before the /level call) so the SAME
    // binding can be persisted as Job.model below -- DESIGN.md §11.2.3.b:
    // written at pending->running, not diff_ready, so a job that fails
    // mid-/level (the longest, most failure-prone stage) still records what
    // it ran under, and a later resubmit() has something real to read.
    const model = job.model ?? deps.defaultLlmModel;
    // Real lifecycle: 'pending' (set on submit) -> 'running' (here) ->
    // 'diff_ready'/'failed'. Without this write the Job row sits at
    // 'pending' for the entire worker run, so the frontend's
    // status === 'running' gate (JobDetail.tsx's SSE subscription and
    // ProgressBanner) never activates.
    //
    // startedAt/model here are the ETA telemetry's write path (DESIGN.md
    // §11.2.3.b) -- model is null for BASELINE, which never calls an LLM at
    // all; deps.defaultLlmModel is always a non-empty string regardless of
    // mode, so without this guard every BASELINE row would falsely record
    // a model it never used.
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
    if (job.mode === 'survey' && deps.openWebUiClient && deps.primerCacheRedis) {
      const openWebUiClient = deps.openWebUiClient;
      const primerCacheRedis = deps.primerCacheRedis;
      try {
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
              const result = await openWebUiClient.chat(
                [
                  {
                    role: 'user',
                    content:
                      'Read the attached document in full. In 2-3 short sentences, describe: the ' +
                      'document type and purpose, the system it specifies (if any), and the domain ' +
                      "conventions or phrasing style it uses. Do not list sections or definitions.",
                  },
                ],
                {
                  files: [{ type: 'file', id: fileId }],
                  // Bounds worst-case latency AND output size -- same
                  // "structured extraction, not creative writing" reasoning
                  // OpenWebUiClient.vision()'s own maxTokens/think:false
                  // already applies to figure captions, here applied to a
                  // one-shot document-orientation summary. Without this, a
                  // reasoning-capable model can burn the whole call on
                  // hidden chain-of-thought (vision()'s own confirmed live
                  // failure mode) or simply ignore "2-3 short sentences" and
                  // produce a reply large enough to blow past /level's own
                  // query-string size limit (see PRIMER_CONTEXT_MAX_CHARS'
                  // own comment) -- this cap plus that clamp are two
                  // independent backstops against the same real risk.
                  maxTokens: 300,
                  think: false,
                  // Same "structured extraction, not creative writing"
                  // reasoning OpenWebUiClient.vision()'s own temperature/seed
                  // comment states: this primer is a factual orientation
                  // summary, not prose, so temperature 0 is correct on its own
                  // merits and seed is defensive hygiene on top in case the
                  // backend ever runs at a non-zero temperature. It matters
                  // MORE here than for a one-off summary: this text is (a)
                  // threaded into every branch's analyze_section prompt, where
                  // sampled wording shifts branch/node structure (the confirmed
                  // 74 vs ~120 node variance), and (b) part of the figure-
                  // caption cache KEY (ingestion main.py's
                  // _figure_caption_cache_key), so a re-sampled primer after
                  // this primer cache's own TTL would invalidate every figure's
                  // 7-day cache entry for the SAME document. Pinning the
                  // sampling makes the same document produce the same primer
                  // whenever it is resampled, which is what makes both caches
                  // actually stable.
                  temperature: 0,
                  seed: 0,
                  // Fixed at PRIMER_FIXED_NUM_CTX (see its own comment
                  // above for why) -- passed explicitly because Ollama
                  // otherwise runs at its own small default window
                  // regardless of prompt size (see LlmChatOptions.numCtx)
                  // and truncates the input with no error at all.
                  numCtx: PRIMER_FIXED_NUM_CTX,
                },
              );
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
      }
    }

    // Runs concurrently with the area-path backfill check (see
    // maybeBackfillAreaPath's own doc comment) -- an independent concern
    // with no data dependency on ingest, so there's no reason to pay its
    // cost serially on top of /ingest's own wall-clock time.
    const [doc] = await Promise.all([
      deps.ingestionClient.ingest(job.fileBuffer, job.filename, false, job.mode, job.id, primerContext),
      maybeBackfillAreaPath(deps.prisma, deps.backfillService, job.areaPath, credential),
    ]);
    // Captions are already here -- no ingestion/`/level` change needed.
    // 1-based index by array position matches the sequential order
    // main.py's per-request vision-call counter narrates figures with
    // (figure_index), which is what the frontend's FigureDescriptions
    // panel keys captions by. Entries with no real caption (vision
    // disabled/failed) are dropped -- same "nothing to show" rule the live
    // SSE narration path already applies (see JobDetail.tsx's narration
    // handler, which only ever sets a caption when figureCaption is
    // truthy).
    const figureDescriptions = ((doc.figures ?? []) as LeveledFigure[])
      .map((figure, index) => ({ figureIndex: index + 1, caption: figure.caption }))
      .filter((entry): entry is { figureIndex: number; caption: string } => Boolean(entry.caption));

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
      linkTypeCatalog = await deps.mcpClient.discoverLinkTypes(credential);
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
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode, job.userId ?? undefined, linkTypeCatalog, model, job.id, primerContext)) as {
      nodes: LeveledNode[];
      warnings?: LeveledWarning[];
      kb_citations?: { source_file: string; similarity: number; relevance: string }[];
      trace_links?: LeveledTraceLink[];
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
        areaPath: job.areaPath,
        groundingScore: node.grounding_score ?? null,
        qualityScore: node.quality_score,
        qualityIssues: node.quality_issues,
        qualityCategoryScores: node.quality_category_scores,
        qualityCategoryChecklist: node.quality_category_checklist,
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
      };
    });

    // Ingestion stored a JobFigureFile row for EVERY figure at ingest time
    // (relevance wasn't known yet then) -- now that the real tree exists,
    // prune down to only the figures some node's figureIds/uncaptionedFigureIds
    // actually references (see JobFigureFile's own Prisma model comment for
    // the full lifecycle). Both lists are unioned: an uncaptioned figure's
    // bytes must be retained too (it might still get manually
    // captioned/reviewed later), not just the ones that already got a
    // caption. Best-effort: a failure here must never fail the whole job
    // over what's purely a storage-cost cleanup step -- a leftover row just
    // means one extra figure sticks around until confirm() deletes it on
    // successful attachment upload, or the retention sweep's safety net
    // eventually reclaims it.
    try {
      const referencedFigureIds = [
        ...new Set(diffInputs.flatMap((node) => [...(node.figureIds ?? []), ...(node.uncaptionedFigureIds ?? [])])),
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
    // Hoisted above the crossJob-only if-block below so the SAME derivation
    // is also in scope for queryIds's project param further down (line
    // ~577) -- both operate on this job's ADO project, not just the
    // Requirement-category resolution.
    const project = job.areaPath.split('\\')[0];
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
      const availableFields = await deps.mcpClient.discoverFields(realRequirementType, credential).catch(() => [] as string[]);
      resolvedCustomerIdField =
        customerIdFieldCandidates.find((candidate) => availableFields.includes(candidate)) ?? null;
    }

    // Always run the near-duplicate check, regardless of Job.followUp --
    // deciding whether a work item already exists under this area path is a
    // required step of every ingestion, not an opt-in extra a user has to
    // remember to tick. A first-time area path simply has nothing indexed
    // yet, so every check legitimately comes back "not a duplicate" at
    // negligible cost (one embed call per node, already fail-open on any
    // dedup-service error -- see dryRunService.diff's own doc comment).
    // Job.followUp itself is left alone (unused now, no schema/DTO churn
    // for a field that's harmless to leave in place).
    // Previously this whole burst (confirmed live: ~543 nodes on a real
    // job) published NO progress signal at all -- 'diff_ready' was the very
    // next event after 'generate_requirements_done', so a job could sit
    // silent for however long the idempotency/dedup-check burst took with
    // no way to tell it from a stall.
    await deps.jobEventsPublisher.publish(job.id, 'dedup_check');
    const diff = await deps.dryRunService.diff(
      diffInputs,
      deps.idempotencyService,
      (text, title, areaPath) => deps.ingestionClient.checkDuplicate(text, title, areaPath),
      (completed, total, currentTitle) => {
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
        ] as any,
        kbCitations: (tree.kb_citations ?? []).map((c) => ({
          sourceFile: c.source_file,
          similarity: c.similarity,
          relevance: c.relevance,
        })) as any,
        figureDescriptions: figureDescriptions as any,
        // ETA telemetry write path, part 2 (DESIGN.md §11.2.3.b). Real
        // pipeline completion, independent of whether/how a human later
        // reviews it -- diffReadyAt is deliberately NOT set in confirm()
        // or reject(). doc.figures.length (every figure), not
        // figureDescriptions.length (already filtered to captioned-only
        // figures above) -- must match the same quantity
        // jobs.controller.ts's preview() counts, or the ETA fit trains on
        // a different quantity than it predicts against.
        blockCount: (doc.blocks ?? []).length,
        figureCount: (doc.figures ?? []).length,
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
    await deps.prisma.job.update({ where: { id: job.id }, data: { status: 'failed' } });
    await deps.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Pipeline failed: ${error instanceof Error ? error.message : String(error)}` },
    });
    await deps.jobEventsPublisher.publish(job.id, 'failed');
    throw error;
  }
}
