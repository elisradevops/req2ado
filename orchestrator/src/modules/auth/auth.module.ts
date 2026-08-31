import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AdoPatProvider } from './ado-pat.provider';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';
import { AuthGuard } from './auth.guard';
import { CredentialVaultService } from './credential-vault.service';
import { AdoCredentialResolver } from './ado-credential.resolver';
import { LlmConfigResolver } from './llm-config.resolver';

/**
 * Real server sessions (Session table, httpOnly cookie) layered on top of
 * the unchanged ADO-PAT-as-identity login (AdoPatProvider) -- the PAT
 * itself is now vaulted (CredentialVaultService, ExternalCredential table),
 * not resent by the browser on every write. AuthGuard is exported so
 * AppModule can register it globally via APP_GUARD; SessionService and
 * CredentialVaultService are exported so other modules (jobs, kb) can
 * resolve @CurrentUser() and the caller's stored ADO credential without a
 * circular import back through this module's own controller.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    AdoPatProvider,
    SessionService,
    AuthGuard,
    Reflector,
    {
      provide: CredentialVaultService,
      inject: [PrismaClient, ConfigService],
      useFactory: (prisma: PrismaClient, config: ConfigService) =>
        new CredentialVaultService(prisma, config.get<string>('CREDENTIAL_ENC_KEY')!, config.get<string>('CREDENTIAL_ENC_KEY_PREVIOUS')),
    },
    AdoCredentialResolver,
    LlmConfigResolver,
  ],
  exports: [AdoPatProvider, SessionService, AuthGuard, CredentialVaultService, AdoCredentialResolver, LlmConfigResolver],
})
export class AuthModule {}
