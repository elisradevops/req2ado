import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { JobsController } from './jobs.controller';
import { AdoController } from './ado.controller';
import { JobEventsController, REDIS_SUBSCRIBER_FACTORY } from './job-events.controller';
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

@Module({
  imports: [ConfigModule, LlmModule, AuthModule],
  controllers: [JobsController, AdoController, JobEventsController, BackfillController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    WorkItemTypeCatalogService,
    {
      provide: McpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new McpClient(
          `${config.get<string>('MCP_URL')}/mcp`,
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
      useFactory: (config: ConfigService) => new IngestionHttpClient(config.get<string>('INGESTION_BASE_URL')!),
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
  ],
})
export class JobsModule {}
