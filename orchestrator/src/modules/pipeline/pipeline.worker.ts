import type { PrismaClient } from '@prisma/client';
import type { IngestionHttpClient } from './ingestion-http.client';
import type { DryRunService, DryRunTreeNode } from '../writeback/dry-run.service';
import type { IdempotencyService } from '../writeback/idempotency.service';

export interface PipelineJobInput {
  id: string;
  areaPath: string;
  customerId: string | null;
  fileBuffer: Buffer;
  filename: string;
}

export interface PipelineWorkerDeps {
  ingestionClient: IngestionHttpClient;
  dryRunService: DryRunService;
  idempotencyService: IdempotencyService;
  prisma: PrismaClient;
}

interface LeveledNode {
  local_id: string;
  parent_local_id: string | null;
  type: string;
  title: string;
  description: string;
  fidelity_hash: string;
  customer_id: string | null;
}

/**
 * The actual pipeline glue that Phases 1-7 never built: chains the real
 * ingestion service (/ingest -> /level, Phase 1/4) into Phase 7's
 * DryRunService, persisting progress on the Job row (Phase 0's model,
 * unused until this task). BASELINE mode only — see this plan's header for
 * why SURVEY-mode wiring is explicitly out of scope here.
 */
export async function runPipelineJob(
  job: PipelineJobInput,
  deps: PipelineWorkerDeps,
): Promise<ReturnType<DryRunService['diff']> extends Promise<infer T> ? T : never> {
  try {
    const doc = await deps.ingestionClient.ingest(job.fileBuffer, job.filename);
    const tree = (await deps.ingestionClient.level(doc, job.customerId)) as { nodes: LeveledNode[] };

    const diffInputs: DryRunTreeNode[] = tree.nodes.map((node) => ({
      localId: node.local_id,
      parentLocalId: node.parent_local_id,
      type: node.type,
      title: node.title,
      description: node.description,
      sourceHash: node.fidelity_hash,
      customerId: node.customer_id,
      areaPath: job.areaPath,
    }));

    const diff = await deps.dryRunService.diff(diffInputs, deps.idempotencyService);

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
    return diff;
  } catch (error) {
    await deps.prisma.job.update({ where: { id: job.id }, data: { status: 'failed' } });
    await deps.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Pipeline failed: ${error instanceof Error ? error.message : String(error)}` },
    });
    throw error;
  }
}
