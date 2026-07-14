import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from './ingestion-http.client';
import type { DryRunService, DryRunTreeNode } from '../writeback/dry-run.service';
import type { IdempotencyService } from '../writeback/idempotency.service';
import type { JobEventsPublisher } from './job-events.publisher';

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
    await deps.jobEventsPublisher.publish(job.id, 'infer_hierarchy_start');
    const tree = (await deps.ingestionClient.level(doc, job.customerId, job.mode)) as { nodes: LeveledNode[] };
    await deps.jobEventsPublisher.publish(job.id, 'generate_requirements_done');

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
    }));

    const diff = await deps.dryRunService.diff(
      diffInputs,
      deps.idempotencyService,
      (text, areaPath) => deps.ingestionClient.checkDuplicate(text, areaPath),
    );

    // `diff` is a plain JSON-serializable array of DryRunDiffEntry; cast past
    // Prisma's generated InputJsonValue type (its structural check does not
    // resolve concrete array-of-interface types against the JSON union even
    // though the runtime value is valid JSON).
    await deps.prisma.job.update({
      where: { id: job.id },
      data: { status: 'diff_ready', dryRunDiff: diff as any },
    });
    await deps.prisma.auditEntry.create({
      data: {
        jobId: job.id,
        message: `Dry-run diff ready: ${diff.length} node(s), ${diff.filter((e) => e.action === 'create').length} to create`,
      },
    });
    await deps.jobEventsPublisher.publish(job.id, 'diff_ready');
    return diff;
  } catch (error) {
    await deps.prisma.job.update({ where: { id: job.id }, data: { status: 'failed' } });
    await deps.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Pipeline failed: ${error instanceof Error ? error.message : String(error)}` },
    });
    await deps.jobEventsPublisher.publish(job.id, 'failed');
    throw error;
  }
}
