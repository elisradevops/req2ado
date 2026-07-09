import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { JobsController } from './jobs.controller';
import { AdoController } from './ado.controller';
import { JobEventsController, REDIS_SUBSCRIBER_FACTORY } from './job-events.controller';
import { JobsService } from './jobs.service';
import { McpClient } from './mcp.client';
import { IngestionHttpClient } from './ingestion-http.client';
import { IdempotencyService } from '../writeback/idempotency.service';
import { JobEventsPublisher } from './job-events.publisher';

@Module({
  imports: [ConfigModule],
  controllers: [JobsController, AdoController, JobEventsController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    {
      provide: McpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new McpClient(`${config.get<string>('MCP_URL')}/mcp`, config.get<string>('MCP_BEARER')!),
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
      inject: [PrismaClient, McpClient, IdempotencyService, IngestionHttpClient, ConfigService],
      useFactory: (
        prisma: PrismaClient,
        mcpClient: McpClient,
        idempotencyService: IdempotencyService,
        ingestionClient: IngestionHttpClient,
        config: ConfigService,
      ) => new JobsService(prisma, mcpClient, idempotencyService, ingestionClient, config.get<string>('REDIS_URL')!),
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
      useFactory: (config: ConfigService) => new JobEventsPublisher(new Redis(config.get<string>('REDIS_URL')!) as any),
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
  ],
})
export class JobsModule {}
