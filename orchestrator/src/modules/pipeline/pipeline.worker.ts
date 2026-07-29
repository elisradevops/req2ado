import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from './ingestion-http.client';
import { resolveCrossJobTraceLinks } from '../writeback/dry-run.service';
import type { DryRunService, DryRunTreeNode } from '../writeback/dry-run.service';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { JobEventsPublisher } from './job-events.publisher';
import type { McpClient } from './mcp.client';
import { DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES } from '../../config/customer-id-fields';
import type { AdoCredentialResolver } from '../auth/ado-credential.resolver';

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

export interface PipelineWorkerDeps {
  ingestionClient: IngestionHttpClient;
  dryRunService: DryRunService;
  idempotencyService: IdempotencyService;
  prisma: PrismaClient;
  jobEventsPublisher: JobEventsPublisher;
  mcpClient: McpClient;
  // Resolves the submitting user's vaulted ADO credential (by job.userId)
  // for the real-ADO-backend discovery calls below (discoverLinkTypes,
  // discoverFields) -- previously these ran with NO credential at all
  // (this worker is a separate BullMQ process with no request-scoped
  // header to read), silently 401ing against a real ADO backend and
  // falling back to an empty/seed catalog. The vault is what makes a
  // per-user credential available here at all.
  adoCredentialResolver: AdoCredentialResolver;
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

interface LeveledSourceRef {
  document_path: string;
  start_offset: number;
  end_offset: number;
  page: number | null;
}

interface LeveledNode {
  local_id: string;
  parent_local_id: string | null;
  type: string;
  title: string;
  description: string;
  fidelity_hash: string;
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
  // QualityCategoryScores docstring (app.workitem.model). Optional for the
  // same backward-compat reason as the other scoring fields.
  quality_category_scores?: { clarity: number; testability: number; atomicity: number; style: number; rationale: number } | null;
  // Previously computed by ingestion (WorkItemNode.source_ref/tags) but
  // dropped here -- neither reached DryRunTreeNode nor any ADO field.
  // Optional for the same backward-compat reason as the scoring fields above.
  source_ref?: LeveledSourceRef | null;
  tags?: string[];
  child_type?: string | null;
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
    // Real lifecycle: 'pending' (set on submit) -> 'running' (here) ->
    // 'diff_ready'/'failed'. Without this write the Job row sits at
    // 'pending' for the entire worker run, so the frontend's
    // status === 'running' gate (JobDetail.tsx's SSE subscription and
    // ProgressBanner) never activates.
    await deps.prisma.job.update({ where: { id: job.id }, data: { status: 'running' } });
    await deps.jobEventsPublisher.publish(job.id, 'parse');
    // mode threaded through so BASELINE never opens ingestion's vision-LLM
    // gate (see IngestionHttpClient.ingest's own doc comment) -- a real job
    // submission never sets skipVision, unlike /jobs/preview. job.id is
    // passed so ingestion can publish real parse-stage narration (figure
    // vision-captioning progress, parse summary) instead of the parse stage
    // being a silent black box.
    const doc = await deps.ingestionClient.ingest(job.fileBuffer, job.filename, false, job.mode, job.id);

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
    // Resolves the submitting user's vaulted ADO credential by job.userId
    // (see PipelineWorkerDeps.adoCredentialResolver's doc comment) --
    // previously ran with no credential at all against a real ADO backend.
    const credential = job.userId ? await deps.adoCredentialResolver.resolve(job.userId) : undefined;
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
    // job.model ?? deps.defaultLlmModel (see PipelineWorkerDeps.defaultLlmModel's
    // doc comment) -- always send a concrete model name, never undefined,
    // so ingestion's _resolve_caps can resolve real caps/tool-support
    // instead of silently falling back to the conservative unknown-model
    // default for the (common) "Default" wizard selection.
    const model = job.model ?? deps.defaultLlmModel;
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode, job.userId ?? undefined, linkTypeCatalog, model, job.id)) as {
      nodes: LeveledNode[];
      warnings?: string[];
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

    const diffInputs: DryRunTreeNode[] = tree.nodes.map((node) => ({
      localId: node.local_id,
      parentLocalId: node.parent_local_id,
      type: node.type,
      title: node.title,
      description: node.description,
      // identity_hash is what actually distinguishes two nodes with
      // byte-identical description text (see LeveledNode's own doc
      // comment) -- fidelity_hash alone would silently collapse them via
      // the idempotency lookup below. Falls back to fidelity_hash for an
      // older/mocked response predating identity_hash, matching the exact
      // pre-identity_hash behavior for that case.
      sourceHash: node.identity_hash ?? node.fidelity_hash,
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
      sourceRef: node.source_ref
        ? {
            documentPath: node.source_ref.document_path,
            startOffset: node.source_ref.start_offset,
            endOffset: node.source_ref.end_offset,
            page: node.source_ref.page,
          }
        : null,
      tags: node.tags ?? [],
      childType: node.child_type,
      traceLinks: traceLinksByLocalId.get(node.local_id) ?? [],
    }));

    const customerIdFieldCandidates = DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES;
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
      const project = job.areaPath.split('\\')[0];
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
    const diff = await deps.dryRunService.diff(
      diffInputs,
      deps.idempotencyService,
      (text, areaPath) => deps.ingestionClient.checkDuplicate(text, areaPath),
    );

    const resolvedDiff =
      resolvedCustomerIdField !== null
        ? await Promise.all(
            diff.map(async (entry) => ({
              ...entry,
              traceLinks: entry.traceLinks
                ? await resolveCrossJobTraceLinks(entry.traceLinks, async (customerId) =>
                    deps.mcpClient.queryIds({ [resolvedCustomerIdField as string]: customerId }, credential),
                  )
                : entry.traceLinks,
            })),
          )
        : diff;

    // `resolvedDiff` is a plain JSON-serializable array of DryRunDiffEntry;
    // cast past Prisma's generated InputJsonValue type (its structural check
    // does not resolve concrete array-of-interface types against the JSON
    // union even though the runtime value is valid JSON).
    await deps.prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'diff_ready',
        dryRunDiff: resolvedDiff as any,
        warnings: (tree.warnings ?? []) as any,
        kbCitations: (tree.kb_citations ?? []).map((c) => ({
          sourceFile: c.source_file,
          similarity: c.similarity,
          relevance: c.relevance,
        })) as any,
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
