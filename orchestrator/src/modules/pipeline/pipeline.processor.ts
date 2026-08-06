import type { SandboxedJob } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { configSchema } from '../../config/config.schema';
import { IngestionHttpClient } from './ingestion-http.client';
import { DryRunService } from '../writeback/dry-run.service';
import { IdempotencyService } from '../writeback/idempotency.service';
import { BackfillService } from '../writeback/backfill.service';
import { JobEventsPublisher } from './job-events.publisher';
import { McpClient } from './mcp.client';
import { runPipelineJob, type PipelineJobInput } from './pipeline.worker';
import { CredentialVaultService } from '../auth/credential-vault.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';

/**
 * BullMQ sandboxed processor: runs in its OWN child process, spawned/pooled
 * by pipeline-worker.main.ts's Worker (see BullMQ's sandboxed-processors
 * docs: https://docs.bullmq.io/guide/workers/sandboxed-processors).
 *
 * Why: pipeline-worker.main.ts previously ran runPipelineJob's actual work
 * (ingest -> /level -> dry-run diff) INLINE in the same process that also
 * holds BullMQ's lock-renewal heartbeat. Observed live: repeated
 * "could not renew lock" errors during real long-running SURVEY jobs, even
 * with no synchronous CPU-blocking code in this app and no manual Redis
 * intervention -- root-caused to macOS/Docker Desktop VM scheduling
 * contention (the whole Docker VM, including this worker process, can get
 * starved of host wall-clock time while Ollama.app -- a separate NATIVE
 * process -- does heavy real GPU/CPU inference), which no in-process fix
 * can address. BullMQ's own docs prescribe exactly this: run the processor
 * in a separate process so the lock-renewal bookkeeping (which stays in
 * the lightweight PARENT process, see pipeline-worker.main.ts) is never
 * vulnerable to whatever delays the child experiences.
 *
 * Each of these clients is constructed ONCE per child process (module-level
 * singleton) and reused across every job BullMQ routes to this child --
 * mirrors pipeline-worker.main.ts's original per-process construction
 * exactly, just relocated to run in the sandboxed child instead of the
 * parent. Queued job data still carries the file as base64 (see
 * pipeline-worker.main.ts's own comment on why), decoded here.
 */
const config = configSchema.parse(process.env);
const prisma = new PrismaClient();
const ingestionClient = new IngestionHttpClient(process.env.INGESTION_BASE_URL ?? 'http://localhost:8000', config.INGESTION_REQUEST_TIMEOUT_MS);
const dryRunService = new DryRunService();
const idempotencyService = new IdempotencyService(prisma);
const jobEventsPublisherRedis = new Redis(config.REDIS_URL);
jobEventsPublisherRedis.on('error', (err) => {
  // eslint-disable-next-line no-console -- worker process logging, not app logging
  console.error('JobEventsPublisher Redis error:', err);
});
const jobEventsPublisher = new JobEventsPublisher(jobEventsPublisherRedis as any);
const mcpClient = new McpClient(`${config.MCP_URL}/api/ado`, config.MCP_BEARER, config.MCP_REQUEST_TIMEOUT_MS);
const backfillService = new BackfillService(mcpClient, ingestionClient, idempotencyService);
const credentialVault = new CredentialVaultService(prisma, config.CREDENTIAL_ENC_KEY, config.CREDENTIAL_ENC_KEY_PREVIOUS);
const adoCredentialResolver = new AdoCredentialResolver(credentialVault);

type QueuedJobData = Omit<PipelineJobInput, 'fileBuffer'> & { fileBufferBase64: string };

export default async function processPipelineJob(job: SandboxedJob<QueuedJobData>) {
  const { fileBufferBase64, ...rest } = job.data;
  const jobInput: PipelineJobInput = { ...rest, fileBuffer: Buffer.from(fileBufferBase64, 'base64') };
  return runPipelineJob(jobInput, {
    ingestionClient,
    dryRunService,
    idempotencyService,
    prisma,
    jobEventsPublisher,
    mcpClient,
    backfillService,
    adoCredentialResolver,
    defaultLlmModel: config.LLM_CHAT_MODEL,
  });
}
