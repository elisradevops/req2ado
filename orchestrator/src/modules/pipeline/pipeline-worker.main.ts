import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { configSchema } from '../../config/config.schema';
import { IngestionHttpClient } from './ingestion-http.client';
import { DryRunService } from '../writeback/dry-run.service';
import { IdempotencyService } from '../writeback/idempotency.service';
import { runPipelineJob, type PipelineJobInput } from './pipeline.worker';

/**
 * BullMQ worker process entrypoint — runs as its own Node process (`node
 * dist/modules/pipeline/pipeline-worker.main.js`), separate from the main
 * NestJS HTTP server, per docs/architecture.md's "TS workers consume jobs"
 * architecture. No automated test for this file (thin bootstrap wiring
 * real dependencies) — matches mcp-ado-server/src/index.ts's precedent.
 */
const config = configSchema.parse(process.env);
const prisma = new PrismaClient();
const ingestionClient = new IngestionHttpClient(process.env.INGESTION_BASE_URL ?? 'http://localhost:8000');
const dryRunService = new DryRunService();
const idempotencyService = new IdempotencyService(prisma);

const worker = new Worker<PipelineJobInput>(
  'req2ado-pipeline',
  async (job) => runPipelineJob(job.data, { ingestionClient, dryRunService, idempotencyService, prisma }),
  { connection: { url: config.REDIS_URL } as any },
);

worker.on('failed', (job, error) => {
  // eslint-disable-next-line no-console -- worker process logging, not app logging
  console.error(`Pipeline job ${job?.id} failed:`, error);
});

// eslint-disable-next-line no-console -- startup banner
process.stdout.write('req2ado pipeline worker listening for jobs on queue "req2ado-pipeline"\n');
