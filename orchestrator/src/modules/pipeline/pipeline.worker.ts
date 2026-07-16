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
}

export interface PipelineWorkerDeps {
  ingestionClient: IngestionHttpClient;
  dryRunService: DryRunService;
  idempotencyService: IdempotencyService;
  prisma: PrismaClient;
  jobEventsPublisher: JobEventsPublisher;
  mcpClient: McpClient;
}

interface LeveledNode {
  local_id: string;
  parent_local_id: string | null;
  type: string;
  title: string;
  description: string;
  fidelity_hash: string;
  customer_id: string | null;
  tags: string[];
  quality_score?: number | null;
  quality_issues?: string[];
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
    let linkTypeCatalog: { referenceName: string; name: string; semanticHint?: string }[] = [];
    try {
      linkTypeCatalog = await deps.mcpClient.discoverLinkTypes();
    } catch {
      linkTypeCatalog = [];
    }

    await deps.jobEventsPublisher.publish(job.id, 'infer_hierarchy_start');
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode, job.areaPath, linkTypeCatalog)) as {
      nodes: LeveledNode[];
      kb_citations?: string[];
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
      tags: node.tags ?? [],
      qualityScore: node.quality_score,
      qualityIssues: node.quality_issues,
      childType: node.child_type,
      traceLinks: traceLinksByLocalId.get(node.local_id) ?? [],
    }));

    const customerIdFieldCandidates = ['Custom.CustomerId', 'Custom.CustomerRequirementId', 'Custom.CustomerID'];
    // Cross-job trace-link targets are always Requirement-type items in
    // practice (System/Customer requirement pairs — the driving use case),
    // so a single discoverFields('Requirement') call is enough; if this
    // assumption stops holding, thread the actual target type through
    // instead of hardcoding it here.
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
      data: { status: 'diff_ready', dryRunDiff: resolvedDiff as any, kbCitations: tree.kb_citations ?? [] },
    });
    await deps.prisma.auditEntry.create({
      data: {
        jobId: job.id,
        message: `Dry-run diff ready: ${resolvedDiff.length} node(s), ${resolvedDiff.filter((e) => e.action === 'create').length} to create`,
      },
    });
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
