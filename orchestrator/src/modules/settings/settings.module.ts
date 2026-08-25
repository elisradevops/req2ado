import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController],
  providers: [
    // Dedicated PrismaClient instance, same per-module-instantiation
    // pattern HealthModule/JobsModule already use.
    { provide: PrismaClient, useValue: new PrismaClient() },
    SettingsService,
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
