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
    await this.queue.add('ingest-and-level', {
      id: job.id,
      areaPath: input.areaPath,
      customerId: input.customerId,
      fileBuffer: input.fileBuffer,
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

    const diff = job.dryRunDiff as { localId: string; action: string }[];
    let createdCount = 0;
    for (const entry of diff) {
      if (entry.action === 'create') {
        const created = await this.mcpClient.createWorkItem('Requirement', {});
        await this.idempotencyService.record(job.sourceHash, job.customerId, job.areaPath, created.id);
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
