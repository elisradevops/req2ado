import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { JobsController } from './jobs.controller';
import { DocumentOverviewService } from './document-overview.service';
import { AdoController } from './ado.controller';
import { JobEventsController, REDIS_COMMAND_CLIENT, REDIS_SUBSCRIBER_FACTORY } from './job-events.controller';
import { JobEventPersistenceService } from './job-event-persistence.service';
import { StaleJobWatchdogService } from './stale-job-watchdog.service';
import { JobRetentionService } from './job-retention.service';
import { EtaService } from './eta.service';
import { JobsService } from './jobs.service';
import { McpClient } from './mcp.client';
import { WorkItemTypeCatalogService } from './work-item-type-catalog.service';
import { IngestionHttpClient } from './ingestion-http.client';
import { IdempotencyService } from '../writeback/idempotency.service';
import { JobEventsPublisher } from './job-events.publisher';
import { BackfillService } from '../writeback/backfill.service';
import { BackfillController } from '../writeback/backfill.controller';
import { LlmModule } from '../llm/llm.module';
import { AuthModule } from '../auth/auth.module';
import { BatchController } from '../batch/batch.controller';
import { BatchService } from '../batch/batch.service';
import { BatchPumpService } from '../batch/batch-pump.service';

@Module({
  imports: [ConfigModule, LlmModule, AuthModule],
  controllers: [JobsController, AdoController, JobEventsController, BackfillController, BatchController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    DocumentOverviewService,
    {
      // Same erased-runtime-type / explicit-factory reasoning this module
      // already documents for IdempotencyService et al -- needed here only
      // because requirementTypeFieldCandidates (below) must be threaded
      // through explicitly; McpClient alone would resolve via a bare class
      // provider fine.
      provide: WorkItemTypeCatalogService,
      inject: [McpClient, ConfigService],
      useFactory: (mcpClient: McpClient, config: ConfigService) =>
        new WorkItemTypeCatalogService(
          mcpClient,
          // Same unset-keeps-the-default-list reasoning as JobsService's own
          // REQUIREMENT_TYPE_FIELD_CANDIDATES wiring below -- one config
          // knob, read in two places, so an override applies consistently
          // to both the real write (JobsService) and this read-only
          // reviewer-facing enrichment.
          config
            .get<string>('REQUIREMENT_TYPE_FIELD_CANDIDATES')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
    },
    {
      provide: McpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new McpClient(
          `${config.get<string>('MCP_URL')}/api/ado`,
          config.get<string>('MCP_BEARER')!,
          config.get<number>('MCP_REQUEST_TIMEOUT_MS'),
        ),
    },
    {
      // IdempotencyService's constructor declares its `prisma` param via
      // `import type { PrismaClient }`, which erases the runtime type at
      // compile time — Nest's constructor-param DI resolution then sees a
      // bare `Function` token instead of `PrismaClient` and fails to
      // resolve it. Every other call site (pipeline-worker.main.ts,
      // pipeline.worker.ts) sidesteps this by manually `new`-ing the
      // service instead of going through Nest DI. This is the first
      // NestJS-module wiring of IdempotencyService, so it needs the same
      // explicit-factory treatment as McpClient/JobsService below rather
      // than a bare class provider. IdempotencyService itself is out of
      // scope for this task and is not modified.
      provide: IdempotencyService,
      inject: [PrismaClient],
      useFactory: (prisma: PrismaClient) => new IdempotencyService(prisma),
    },
    {
      provide: IngestionHttpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new IngestionHttpClient(config.get<string>('INGESTION_BASE_URL')!, config.get<number>('INGESTION_REQUEST_TIMEOUT_MS')!),
    },
    {
      provide: JobsService,
      inject: [PrismaClient, McpClient, IdempotencyService, IngestionHttpClient, JobEventsPublisher, ConfigService],
      useFactory: (
        prisma: PrismaClient,
        mcpClient: McpClient,
        idempotencyService: IdempotencyService,
        ingestionClient: IngestionHttpClient,
        jobEventsPublisher: JobEventsPublisher,
        config: ConfigService,
      ) =>
        new JobsService(
          prisma,
          mcpClient,
          idempotencyService,
          ingestionClient,
          config.get<string>('REDIS_URL')!,
          config.get<string>('ADO_INITIAL_STATE')!,
          config.get<number>('CONFIRM_WRITE_CONCURRENCY')!,
          // Unset keeps JobsService's own default candidate list (see its
          // constructor) rather than passing an empty array here, which
          // would silently disable Customer ID field resolution entirely.
          config
            .get<string>('CUSTOMER_ID_FIELD_CANDIDATES')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          // Same MAX_UPLOAD_SIZE_MB config the upload-acceptance check
          // already uses (see 'MAX_UPLOAD_SIZE_BYTES' provider below) --
          // reused for resubmit retention rather than a second config knob.
          config.get<number>('MAX_UPLOAD_SIZE_MB')! * 1024 * 1024,
          jobEventsPublisher,
          // Same unset-keeps-the-default-list reasoning as
          // CUSTOMER_ID_FIELD_CANDIDATES above.
          config
            .get<string>('REQUIREMENT_TYPE_FIELD_CANDIDATES')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
    },
    {
      provide: 'MAX_UPLOAD_SIZE_BYTES',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get<number>('MAX_UPLOAD_SIZE_MB')! * 1024 * 1024,
    },
    {
      // Constructed with `import type Redis` erased at runtime the same way
      // IdempotencyService's `prisma` param is (see the comment above) — a
      // concrete `new Redis(...)` instance is provided via useFactory rather
      // than relying on Nest's constructor-param token resolution.
      provide: JobEventsPublisher,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(config.get<string>('REDIS_URL')!);
        // ioredis clients are plain EventEmitters — an 'error' event with
        // zero listeners throws synchronously and crashes the process.
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        redis.on('error', (err) => console.error('JobEventsPublisher Redis error:', err));
        return new JobEventsPublisher(redis as any);
      },
    },
    {
      // Each SSE connection needs its own dedicated Redis client: once
      // `.subscribe()` is called on an ioredis connection, that connection
      // can no longer issue any other command, so a shared singleton can't
      // be reused across concurrent SSE clients. This factory constructs a
      // fresh connection per `JobEventsController.streamEvents` call,
      // against the same `REDIS_URL` the BullMQ `Queue` in JobsService uses.
      provide: REDIS_SUBSCRIBER_FACTORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => () => new Redis(config.get<string>('REDIS_URL')!),
    },
    {
      // SWEEP.md section 8a: JobEventsController.streamEvents now subscribes
      // BEFORE running its replay reads (GET :current / LRANGE
      // :narration-log), so those reads can no longer share the
      // per-connection subscriber above once it's subscribed -- an ioredis
      // client in subscriber mode can't issue any other command. This is a
      // single SHARED connection across every open SSE stream in the
      // process (never per-request, unlike REDIS_SUBSCRIBER_FACTORY above),
      // matching the exact two-connection split JobEventPersistenceService
      // already uses below. It only ever issues one GET plus one LRANGE per
      // SSE open, which ioredis happily interleaves across concurrent
      // callers on one connection.
      provide: REDIS_COMMAND_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(config.get<string>('REDIS_URL')!);
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        redis.on('error', (err) => console.error('JobEventsController command-client Redis error:', err));
        return redis;
      },
    },
    {
      // TWO dedicated connections, not one -- the first is psubscribe'd for
      // the lifetime of the process (same "subscribed connections can't
      // issue other commands" constraint as REDIS_SUBSCRIBER_FACTORY above)
      // and can never run KEYS/LRANGE/GET again once that happens; the
      // second stays a plain command connection for
      // backfillMissedEvents()'s own reads (see that service's own doc
      // comment for why the backfill pass exists at all).
      provide: JobEventPersistenceService,
      inject: [ConfigService, PrismaClient],
      useFactory: (config: ConfigService, prisma: PrismaClient) =>
        new JobEventPersistenceService(
          new Redis(config.get<string>('REDIS_URL')!) as any,
          new Redis(config.get<string>('REDIS_URL')!) as any,
          prisma,
        ),
    },
    {
      // checkIntervalMs/staleThresholdMs are plain numbers with no
      // injectable token of their own -- needs the same explicit-factory
      // treatment as every other numeric-config-carrying provider here.
      provide: StaleJobWatchdogService,
      inject: [PrismaClient, JobsService, ConfigService],
      useFactory: (prisma: PrismaClient, jobsService: JobsService, config: ConfigService) =>
        new StaleJobWatchdogService(
          prisma,
          jobsService,
          config.get<number>('STALE_JOB_CHECK_INTERVAL_MS')!,
          config.get<number>('STALE_JOB_THRESHOLD_MS')!,
        ),
    },
    {
      // checkIntervalMs/maxAgeMs are plain numbers with no injectable token
      // of their own -- same explicit-factory treatment as
      // StaleJobWatchdogService above.
      provide: JobRetentionService,
      inject: [PrismaClient, ConfigService],
      useFactory: (prisma: PrismaClient, config: ConfigService) =>
        new JobRetentionService(
          prisma,
          config.get<number>('JOB_RETENTION_CHECK_INTERVAL_MS')!,
          config.get<number>('JOB_RETENTION_MAX_AGE_MS')!,
        ),
    },
    {
      // EtaService's constructor params (`prisma: PrismaClient`,
      // `defaultModel: string`) hit the same erased-runtime-type DI issue
      // documented on IdempotencyService above for its `prisma` param --
      // same explicit-factory treatment. defaultModel reuses LLM_CHAT_MODEL,
      // the SAME config key pipeline.processor.ts resolves
      // PipelineWorkerDeps.defaultLlmModel from, so an unspecified/"Default"
      // model estimate resolves to the exact model a real SURVEY run would
      // actually use (DESIGN.md §11.2.3.b/.c).
      provide: EtaService,
      inject: [PrismaClient, ConfigService],
      useFactory: (prisma: PrismaClient, config: ConfigService) => new EtaService(prisma, config.get<string>('LLM_CHAT_MODEL')!),
    },
    {
      // BackfillService's constructor params are declared via `import type`
      // (see backfill.service.ts) -- same erased-runtime-type DI issue this
      // module already documents for IdempotencyService above, so it needs
      // the same explicit-factory treatment rather than a bare class
      // provider.
      provide: BackfillService,
      inject: [McpClient, IngestionHttpClient, IdempotencyService],
      useFactory: (mcpClient: McpClient, ingestionClient: IngestionHttpClient, idempotencyService: IdempotencyService) =>
        new BackfillService(mcpClient, ingestionClient, idempotencyService),
    },
    {
      // NEW-05 batch/folder ingestion. BatchService's constructor params
      // are declared via `import type` (see batch.service.ts) -- same
      // erased-runtime-type DI issue this module already documents for
      // IdempotencyService/BackfillService above, hence the explicit-factory
      // treatment. Reuses the SAME 'MAX_UPLOAD_SIZE_BYTES' token
      // JobsController already relies on -- one config knob, not two.
      provide: BatchService,
      inject: [PrismaClient, JobsService, 'MAX_UPLOAD_SIZE_BYTES', ConfigService],
      useFactory: (prisma: PrismaClient, jobsService: JobsService, maxUploadSizeBytes: number, config: ConfigService) =>
        new BatchService(
          prisma,
          jobsService,
          maxUploadSizeBytes,
          config.get<number>('BATCH_SURVEY_CONCURRENCY')!,
          config.get<number>('BATCH_SUBMIT_STUCK_MS')!,
        ),
    },
    {
      provide: BatchPumpService,
      inject: [BatchService, ConfigService],
      useFactory: (batchService: BatchService, config: ConfigService) =>
        new BatchPumpService(batchService, config.get<number>('BATCH_PUMP_INTERVAL_MS')!),
    },
    {
      provide: 'MAX_BATCH_FILES',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get<number>('MAX_BATCH_FILES')!,
    },
  ],
})
export class JobsModule {}
