import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { KbIngestBatchController } from './kb-ingest-batch.controller';
import { KbIngestBatchService } from './kb-ingest-batch.service';
import { DEFAULT_BACKOFF_MS, KbIngestRunner } from './kb-ingest-runner';
import { KbIngestRunnerTimer } from './kb-ingest-runner-timer';
import { KbIngestRetentionService } from './kb-ingest-retention.service';
import { IngestionHttpClient } from '../pipeline/ingestion-http.client';
import { AuthModule } from '../auth/auth.module';
import { CredentialVaultService } from '../auth/credential-vault.service';
import { LlmConfigResolver } from '../auth/llm-config.resolver';
import { Queue } from 'bullmq';
import { logQueueErrors } from '../../common/queue-errors';
import { KB_PROFILE_QUEUE, KbProfileScheduler } from './kb-profile.scheduler';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [KbController, KbIngestBatchController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    {
      provide: IngestionHttpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new IngestionHttpClient(config.get<string>('INGESTION_BASE_URL')!, config.get<number>('INGESTION_REQUEST_TIMEOUT_MS')!),
    },
    {
      // Builds the user's KB profile in the background after their knowledge base changes (managed BullMQ queue + worker).
      provide: KbProfileScheduler,
      inject: [ConfigService, IngestionHttpClient, LlmConfigResolver],
      useFactory: (config: ConfigService, ingestion: IngestionHttpClient, resolver: LlmConfigResolver) => {
        const redisUrl = config.get<string>('REDIS_URL')!;
        return new KbProfileScheduler({
          queue: logQueueErrors(new Queue(KB_PROFILE_QUEUE, { connection: { url: redisUrl } as never }), KB_PROFILE_QUEUE),
          ingestion,
          resolver,
          profileModel: config.get<string>('KB_PROFILE_MODEL') ?? '',
          redisUrl,
        });
      },
    },
    {
      provide: KbIngestBatchService,
      inject: [PrismaClient],
      useFactory: (prisma: PrismaClient) => new KbIngestBatchService(prisma),
    },
    {
      provide: KbService,
      inject: [PrismaClient, IngestionHttpClient, CredentialVaultService, KbProfileScheduler, KbIngestBatchService],
      useFactory: (
        prisma: PrismaClient,
        ingestionClient: IngestionHttpClient,
        credentialVault: CredentialVaultService,
        scheduler: KbProfileScheduler,
        batches: KbIngestBatchService,
      ) => new KbService(prisma, ingestionClient, credentialVault, scheduler, batches),
    },
    {
      // Ingests the files of the users' batches, one at a time (see KbIngestRunner).
      provide: KbIngestRunner,
      inject: [PrismaClient, KbService, KbProfileScheduler, ConfigService],
      useFactory: (prisma: PrismaClient, kb: KbService, scheduler: KbProfileScheduler, config: ConfigService) =>
        new KbIngestRunner(prisma, kb, scheduler, {
          itemTimeoutMs: config.get<number>('KB_INGEST_ITEM_TIMEOUT_MS')!,
          maxAttempts: config.get<number>('KB_INGEST_MAX_ATTEMPTS')!,
          backoffMs: DEFAULT_BACKOFF_MS,
        }),
    },
    {
      // Forgets finished batches after KB_INGEST_RETENTION_MS, checked every six hours.
      provide: KbIngestRetentionService,
      inject: [KbIngestBatchService, ConfigService],
      useFactory: (batches: KbIngestBatchService, config: ConfigService) =>
        new KbIngestRetentionService(batches, 6 * 60 * 60_000, config.get<number>('KB_INGEST_RETENTION_MS')!),
    },
    {
      provide: KbIngestRunnerTimer,
      inject: [KbIngestRunner, ConfigService],
      useFactory: (runner: KbIngestRunner, config: ConfigService) => new KbIngestRunnerTimer(runner, config.get<number>('KB_INGEST_TICK_MS')!),
    },
  ],
})
export class KbModule {}
