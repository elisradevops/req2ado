import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { McpClient } from './mcp.client';
import { IdempotencyService } from '../writeback/idempotency.service';

@Module({
  imports: [ConfigModule],
  controllers: [JobsController],
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
      provide: JobsService,
      inject: [PrismaClient, McpClient, IdempotencyService, ConfigService],
      useFactory: (prisma: PrismaClient, mcpClient: McpClient, idempotencyService: IdempotencyService, config: ConfigService) =>
        new JobsService(prisma, mcpClient, idempotencyService, config.get<string>('REDIS_URL')!),
    },
    {
      provide: 'MAX_UPLOAD_SIZE_BYTES',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get<number>('MAX_UPLOAD_SIZE_MB')! * 1024 * 1024,
    },
  ],
})
export class JobsModule {}
