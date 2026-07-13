import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { IngestionHttpClient } from '../pipeline/ingestion-http.client';

@Module({
  imports: [ConfigModule],
  controllers: [KbController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    {
      provide: IngestionHttpClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new IngestionHttpClient(config.get<string>('INGESTION_BASE_URL')!),
    },
    {
      provide: KbService,
      inject: [PrismaClient, IngestionHttpClient],
      useFactory: (prisma: PrismaClient, ingestionClient: IngestionHttpClient) => new KbService(prisma, ingestionClient),
    },
  ],
})
export class KbModule {}
