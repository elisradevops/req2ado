import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { HealthController } from './health.controller';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [
    // A dedicated PrismaClient/Redis connection for health checks, same
    // per-module-instantiation pattern JobsModule already uses -- health
    // checks must work even if other modules' own connections are the ones
    // that are actually degraded.
    { provide: PrismaClient, useValue: new PrismaClient() },
    {
      provide: Redis,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Redis(config.get<string>('REDIS_URL')!, { lazyConnect: true }),
    },
  ],
})
export class HealthModule {}
