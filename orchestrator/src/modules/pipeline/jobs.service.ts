import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import type { McpClient } from './mcp.client';
import type { IdempotencyService } from '../writeback/idempotency.service';

export interface SubmitJobInput {
  userId: string;
  areaPath: string;
  customerId: string | null;
  fileBuffer: Buffer;
  filename: string;
  sourceHash: string;
}

@Injectable()
export class JobsService {
  private readonly queue: Queue;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mcpClient: McpClient,
    private readonly idempotencyService: IdempotencyService,
    redisUrl: string,
  ) {
    this.queue = new Queue('req2ado-pipeline', { connection: { url: redisUrl } as any });
  }

  async submit(input: SubmitJobInput): Promise<{ jobId: string }> {
    const job = await this.prisma.job.create({
      data: {
        userId: input.userId,
        mode: 'baseline',
        status: 'pending',
        sourceHash: input.sourceHash,
        areaPath: input.areaPath,
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
      fileBufferBase64: input.fileBuffer.toString('base64'),
      filename: input.filename,
    });
    return { jobId: job.id };
  }

  async getById(id: string): Promise<{ id: string; status: string; dryRunDiff: unknown } | null> {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) return null;
    return { id: job.id, status: job.status, dryRunDiff: job.dryRunDiff };
  }

  async confirm(id: string): Promise<{ status: string; createdCount: number }> {
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
    const diff = job.dryRunDiff as { localId: string; action: string; sourceHash: string; customerId: string | null }[];
    let createdCount = 0;
    for (const entry of diff) {
      if (entry.action === 'create') {
        const created = await this.mcpClient.createWorkItem('Requirement', {});
        await this.idempotencyService.record(entry.sourceHash, entry.customerId, job.areaPath, created.id);
        createdCount += 1;
      }
    }

    await this.prisma.job.update({
      where: { id },
      data: { status: 'succeeded', confirmedAt: new Date(), completedAt: new Date() },
    });
    return { status: 'succeeded', createdCount };
  }
}
