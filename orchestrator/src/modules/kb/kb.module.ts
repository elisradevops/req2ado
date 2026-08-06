import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { IngestionHttpClient } from '../pipeline/ingestion-http.client';
import { AuthModule } from '../auth/auth.module';
import { CredentialVaultService } from '../auth/credential-vault.service';

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
      provide: KbService,
      inject: [PrismaClient, IngestionHttpClient, CredentialVaultService],
      useFactory: (prisma: PrismaClient, ingestionClient: IngestionHttpClient, credentialVault: CredentialVaultService) =>
        new KbService(prisma, ingestionClient, credentialVault),
    },
  ],
})
export class KbModule {}
