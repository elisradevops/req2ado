import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import type { McpClient } from './mcp.client';
import type { IngestionHttpClient } from './ingestion-http.client';
import type { IdempotencyService } from '../writeback/idempotency.service';

export interface SubmitJobInput {
  areaPath: string;
  customerId: string | null;
  mode: 'baseline' | 'survey';
  fileBuffer: Buffer;
  filename: string;
  sourceHash: string;
  state: string;
  iterationPath: string | null;
}

@Injectable()
export class JobsService {
  private readonly queue: Queue;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mcpClient: McpClient,
    private readonly idempotencyService: IdempotencyService,
    private readonly ingestionClient: IngestionHttpClient,
    redisUrl: string,
  ) {
    this.queue = new Queue('req2ado-pipeline', { connection: { url: redisUrl } as any });
  }

  async submit(input: SubmitJobInput): Promise<{ jobId: string }> {
    const job = await this.prisma.job.create({
      data: {
        mode: input.mode,
        status: 'pending',
        sourceHash: input.sourceHash,
        areaPath: input.areaPath,
        state: input.state,
        iterationPath: input.iterationPath,
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
    await this.queue.add('ingest-and-level', {
      id: job.id,
      areaPath: input.areaPath,
      customerId: input.customerId,
      mode: input.mode,
      fileBufferBase64: input.fileBuffer.toString('base64'),
      filename: input.filename,
    });
    await this.prisma.auditEntry.create({
      data: { jobId: job.id, message: `Job submitted: ${input.filename}, areaPath=${input.areaPath}` },
    });
    return { jobId: job.id };
  }

  async getAuditTrail(id: string): Promise<{ id: string; message: string; createdAt: Date }[]> {
    return this.prisma.auditEntry.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  }

  // docs/architecture.md's "Customer ID Field Resolution": verified at
  // runtime against ado_discover_fields, never hardcoded to System.CustomerId
  // (System.* is ADO's reserved built-in namespace, not custom fields).
  // Candidate priority list matches DocGen's real-world discovered naming
  // conventions, each verified present before use rather than trusted blind.
  // If none match, customerId is left off the written item (traceability
  // metadata, not a required field for a valid ADO write) — not a hard failure.
  private async resolveCustomerIdField(
    workItemType: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<string | null> {
    const candidates = ['Custom.CustomerId', 'Custom.CustomerRequirementId', 'Custom.CustomerID'];
    const availableFields = await this.mcpClient.discoverFields(workItemType, credential);
    return candidates.find((candidate) => availableFields.includes(candidate)) ?? null;
  }

  async getById(id: string): Promise<{ id: string; status: string; dryRunDiff: unknown } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    return { id: job.id, status: job.status, dryRunDiff: job.dryRunDiff };
  }

  async confirm(
    id: string,
    credential?: { orgUrl: string; pat: string },
  ): Promise<{ status: string; createdCount: number }> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job || job.status !== 'diff_ready') {
      throw new Error(`Job ${id} is not in a confirmable state`);
    }
    await this.prisma.job.update({ where: { id }, data: { status: 'writing' } });

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
      tags?: string[];
    }[];

    // Tree order from ingestion (parents appear before children — see
    // tree_builder.py's stack-based construction) means a single left-to-right
    // pass is sufficient: every entry's parentLocalId, if non-null, already
    // has its ADO id in this map by the time we reach the child.
    const adoIdByLocalId = new Map<string, number>();
    // Customer ID's real ref name is runtime-verified per work-item type, not
    // hardcoded (docs/architecture.md's "Customer ID Field Resolution") —
    // cached per type for this confirm() call so discoverFields is called at
    // most once per distinct type in the diff, not once per node.
    const customerIdFieldByType = new Map<string, string | null>();
    let createdCount = 0;

    for (const entry of diff) {
      // 'dedup_skip' is skipped the same as 'reuse': both already have a
      // real ADO id to point at, just with different certainty (exact-hash
      // fact vs embedding-similarity judgment) — see DryRunDiffEntry's doc
      // comment. Neither should trigger a create.
      if ((entry.action === 'reuse' || entry.action === 'dedup_skip') && entry.existingAdoId !== null) {
        adoIdByLocalId.set(entry.localId, entry.existingAdoId);
        continue;
      }
      const fields: Record<string, string> = {
        'System.Title': entry.title,
        'System.Description': entry.description,
        'System.State': job.state,
        'System.AreaPath': job.areaPath,
      };
      if (job.iterationPath) {
        fields['System.IterationPath'] = job.iterationPath;
      }
      if (entry.tags && entry.tags.length > 0) {
        fields['System.Tags'] = entry.tags.join(';');
      }
      if (entry.customerId !== null) {
        if (!customerIdFieldByType.has(entry.type)) {
          customerIdFieldByType.set(
            entry.type,
            await this.resolveCustomerIdField(entry.type, credential),
          );
        }
        const customerIdField = customerIdFieldByType.get(entry.type);
        if (customerIdField !== null && customerIdField !== undefined) {
          fields[customerIdField] = entry.customerId;
        }
      }
      const created = await this.mcpClient.createWorkItem(entry.type, fields, credential);
      adoIdByLocalId.set(entry.localId, created.id);
      await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
      // Backstop future dedup checks against this newly-real item. Best-effort:
      // an upsert failure here must not fail the write that already succeeded
      // in ADO — it only means a future near-duplicate might not be caught.
      try {
        await this.ingestionClient.upsertDedupEntry(String(created.id), entry.description, job.areaPath);
      } catch (error) {
        // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
        console.error(`Dedup upsert failed for newly-created item ${created.id}:`, error);
      }
      createdCount += 1;
    }

    for (const entry of diff) {
      if (entry.parentLocalId === null) continue;
      // Never re-parent an existing ADO item based on a probabilistic
      // dedup match — that would silently mutate real ADO hierarchy off a
      // similarity guess, not a certainty. A NEW child linking UP to a
      // dedup_skip parent is fine (parentAdoId lookup still resolves); only
      // the skip-node-as-a-CHILD case is suppressed here.
      if (entry.action === 'dedup_skip') continue;
      const childAdoId = adoIdByLocalId.get(entry.localId);
      const parentAdoId = adoIdByLocalId.get(entry.parentLocalId);
      if (childAdoId === undefined || parentAdoId === undefined) continue; // defensive — should not happen given tree order
      await this.mcpClient.linkParentChild(childAdoId, parentAdoId, credential);
    }

    await this.prisma.job.update({
      where: { id },
      data: { status: 'succeeded', confirmedAt: new Date(), completedAt: new Date() },
    });
    await this.prisma.auditEntry.create({
      data: { jobId: id, message: `Job confirmed: ${createdCount} work item(s) created` },
    });
    return { status: 'succeeded', createdCount };
  }
}
