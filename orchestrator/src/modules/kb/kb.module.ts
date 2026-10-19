import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { IngestionHttpClient } from '../pipeline/ingestion-http.client';
import { AuthModule } from '../auth/auth.module';
import { CredentialVaultService } from '../auth/credential-vault.service';
import { LlmConfigResolver } from '../auth/llm-config.resolver';
import { Queue } from 'bullmq';
import { KB_PROFILE_QUEUE, KbProfileScheduler } from './kb-profile.scheduler';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [KbController],
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
          queue: new Queue(KB_PROFILE_QUEUE, { connection: { url: redisUrl } as never }),
          ingestion,
          resolver,
          profileModel: config.get<string>('KB_PROFILE_MODEL') ?? '',
          redisUrl,
        });
      },
    },
    {
      provide: KbService,
      inject: [PrismaClient, IngestionHttpClient, CredentialVaultService, KbProfileScheduler],
      useFactory: (prisma: PrismaClient, ingestionClient: IngestionHttpClient, credentialVault: CredentialVaultService, scheduler: KbProfileScheduler) =>
        new KbService(prisma, ingestionClient, credentialVault, scheduler),
    },
  ],
})
export class KbModule {}
