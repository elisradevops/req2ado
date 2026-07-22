import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from './ingestion-http.client';
import { resolveCrossJobTraceLinks } from '../writeback/dry-run.service';
import type { DryRunService, DryRunTreeNode } from '../writeback/dry-run.service';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { JobEventsPublisher } from './job-events.publisher';
import type { McpClient } from './mcp.client';

export interface PipelineJobInput {
  id: string;
  areaPath: string;
  customerId: string | null;
  mode: 'baseline' | 'survey';
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
  customer_id: string | null;
  // SURVEY-only signals (see ingestion's WorkItemNode) -- null/[] for
  // BASELINE nodes and for any SURVEY node when scoring wasn't enabled.
  // Optional (not just nullable) because they didn't exist on this
  // response shape before this round -- an older/mocked ingestion response
  // in a test omitting them entirely must not crash the mapping below.
  grounding_score?: number | null;
  quality_score?: number | null;
  quality_issues?: string[];
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
    // Real lifecycle: 'pending' (set on submit) -> 'running' (here) ->
    // 'diff_ready'/'failed'. Without this write the Job row sits at
    // 'pending' for the entire worker run, so the frontend's
    // status === 'running' gate (JobDetail.tsx's SSE subscription and
    // ProgressBanner) never activates.
    await deps.prisma.job.update({ where: { id: job.id }, data: { status: 'running' } });
    await deps.jobEventsPublisher.publish(job.id, 'parse');
    const doc = await deps.ingestionClient.ingest(job.fileBuffer, job.filename);

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
    // Known limitation: this BullMQ worker runs with no per-user ADO
    // credential (only confirm(), a synchronous request-scoped call,
    // receives the submitting user's PAT via headers). In real-ADO backend
    // mode this call will 401 and degrade to the empty-catalog fallback
    // above — trace-link inference is effectively mock-backend-only until a
    // future task threads a credential through the job queue. Accepted for
    // this slice; not a bug.
    let linkTypeCatalog: { referenceName: string; name: string; semanticHint?: string }[] = [];
    try {
      linkTypeCatalog = await deps.mcpClient.discoverLinkTypes();
    } catch {
      linkTypeCatalog = [];
    }

    await deps.jobEventsPublisher.publish(job.id, 'infer_hierarchy_start');
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode, job.areaPath, linkTypeCatalog, job.model, job.id)) as {
      nodes: LeveledNode[];
      warnings?: string[];
      kb_citations?: { source_file: string; similarity: number; relevance: string }[];
      trace_links?: LeveledTraceLink[];
    };
    await deps.jobEventsPublisher.publish(job.id, 'generate_requirements_done');

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
      sourceHash: node.fidelity_hash,
      customerId: node.customer_id,
      areaPath: job.areaPath,
      groundingScore: node.grounding_score ?? null,
      qualityScore: node.quality_score,
      qualityIssues: node.quality_issues,
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

    const customerIdFieldCandidates = ['Custom.CustomerId', 'Custom.CustomerRequirementId', 'Custom.CustomerID'];
    // Cross-job trace-link targets are always Requirement-type items in
    // practice (System/Customer requirement pairs — the driving use case),
    // so a single discoverFields('Requirement') call is enough; if this
    // assumption stops holding, thread the actual target type through
    // instead of hardcoding it here.
    // Same credential gap as discoverLinkTypes above: this worker has no
    // per-user ADO PAT, so discoverFields/queryIds below will 401 in
    // real-ADO backend mode and fall back to their empty-result defaults —
    // crossJob resolution silently yields nothing. Mock-backend-only for now.
    let resolvedCustomerIdField: string | null = null;
    if ((tree.trace_links ?? []).some((l) => l.target_kind === 'crossJob')) {
      const availableFields = await deps.mcpClient.discoverFields('Requirement').catch(() => [] as string[]);
      resolvedCustomerIdField =
        customerIdFieldCandidates.find((candidate) => availableFields.includes(candidate)) ?? null;
    }

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
                    deps.mcpClient.queryIds({ [resolvedCustomerIdField as string]: customerId }),
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
    await deps.prisma.job.update({ where: { id: job.id }, data: { status: 'failed' } });
    await deps.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Pipeline failed: ${error instanceof Error ? error.message : String(error)}` },
    });
    await deps.jobEventsPublisher.publish(job.id, 'failed');
    throw error;
  }
}
