import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AzureAdProvider } from './azure-ad.provider';
import { RolesGuard } from './roles.guard';

@Module({
  providers: [
    AzureAdProvider,
    Reflector,
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AzureAdProvider],
})
export class AuthModule {}
