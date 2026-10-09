import type { SandboxedJob } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { configSchema } from '../../config/config.schema';
import { IngestionHttpClient } from './ingestion-http.client';
import { DryRunService } from '../writeback/dry-run.service';
import { IdempotencyService } from '../writeback/idempotency.service';
import { BackfillService } from '../writeback/backfill.service';
import { JobEventsPublisher } from './job-events.publisher';
import { ProgressService } from './progress.service';
import { McpClient } from './mcp.client';
import { runPipelineJob, type PipelineJobInput } from './pipeline.worker';
import { CredentialVaultService } from '../auth/credential-vault.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';
import { LlmConfigResolver } from '../auth/llm-config.resolver';
import { OpenWebUiClientFactory, type OpenWebUiGlobalConfig } from '../llm/openwebui-client.factory';
import { SettingsService } from '../settings/settings.service';

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
// Job transparency (B4): counted progress, only when LIVE_PROGRESS is on. Same
// per-process direct-Redis pattern as above (this child has no DI container).
const progressService = config.LIVE_PROGRESS
  ? new ProgressService(jobEventsPublisherRedis as any, () => {
      const subscriber = new Redis(config.REDIS_URL);
      // ioredis throws on an unhandled 'error' event; one subscriber per tracked job.
      subscriber.on('error', (err) => {
        // eslint-disable-next-line no-console -- worker process logging, not app logging
        console.error('ProgressService subscriber Redis error:', err);
      });
      return subscriber as any;
    })
  : undefined;
const mcpClient = new McpClient(`${config.MCP_URL}/api/ado`, config.MCP_BEARER, config.MCP_REQUEST_TIMEOUT_MS);
const backfillService = new BackfillService(mcpClient, ingestionClient, idempotencyService);
const credentialVault = new CredentialVaultService(prisma, config.CREDENTIAL_ENC_KEY, config.CREDENTIAL_ENC_KEY_PREVIOUS);
const adoCredentialResolver = new AdoCredentialResolver(credentialVault);
// Settings window (NEW-07) -- reuses this process's own `prisma`, same
// per-process-singleton pattern every other client here follows.
const settingsService = new SettingsService(prisma);
// Phase 6c: whole-document AI context primer (see pipeline.worker.ts's own
// primer wiring block). A per-user, per-job factory now -- NOT a single
// shared OpenWebUiClient -- since this sandboxed child process can run
// jobs from different users, and a shared client would leak whichever
// user's token it was first constructed with into every other user's job
// (see PipelineWorkerDeps.openWebUiClientFactory's own doc comment).
// Same config fields llm.module.ts's own useFactory provider builds; this
// child process has no NestJS DI container of its own (see this file's own
// doc comment above), so it's constructed directly here, same as every
// other client above.
const openWebUiGlobalConfig: OpenWebUiGlobalConfig = {
  LLM_BASE_URL: config.LLM_BASE_URL,
  LLM_CHAT_BASE_URL: config.LLM_CHAT_BASE_URL,
  LLM_SEND_SEED: config.LLM_SEND_SEED === 'true',
  LLM_SEND_REASONING_EFFORT: config.LLM_SEND_REASONING_EFFORT === 'true',
  LLM_MODEL_HIDE_PATTERNS: config.LLM_MODEL_HIDE_PATTERNS,
  LLM_TRUSTED_LOCAL: config.LLM_TRUSTED_LOCAL,
  EMBED_TRANSPORT: config.EMBED_TRANSPORT,
  EMBED_BASE_URL: config.EMBED_BASE_URL,
  EMBED_MODEL: config.EMBED_MODEL,
  EMBED_PATH: config.EMBED_PATH,
  SHOW_PATH: config.SHOW_PATH,
  FILES_UPLOAD_PATH: config.FILES_UPLOAD_PATH,
  FILES_STATUS_PATH: config.FILES_STATUS_PATH,
  LLM_REQUEST_TIMEOUT_MS: config.LLM_REQUEST_TIMEOUT_MS,
};
const llmConfigResolver = new LlmConfigResolver(credentialVault);
const openWebUiClientFactory = new OpenWebUiClientFactory(openWebUiGlobalConfig, llmConfigResolver);
// Dedicated connection for the primer's content-hash cache -- this child
// process has no NestJS DI container of its own (see this file's own doc
// comment above) and there's no existing general-purpose Redis command
// client here to reuse instead, hence a second direct `new Redis(...)`,
// same pattern jobEventsPublisherRedis above already uses.
const primerCacheRedis = new Redis(config.REDIS_URL);
primerCacheRedis.on('error', (err) => {
  // eslint-disable-next-line no-console -- worker process logging, not app logging
  console.error('PrimerCache Redis error:', err);
});

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
    progressService,
    mcpClient,
    backfillService,
    adoCredentialResolver,
    defaultLlmModel: config.LLM_CHAT_MODEL,
    openWebUiClientFactory,
    primerCacheRedis: primerCacheRedis as any,
    settingsService,
    ocrLanguages: config.OCR_LANGUAGES,
  });
}
