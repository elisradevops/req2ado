import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdoPatProvider } from './ado-pat.provider';
import { AuthController } from './auth.controller';

/** DocGen-pattern login: the ADO org URL + PAT ARE the identity and the
 * permissions (see AdoPatProvider) — no app-level session/JWT, no Azure AD,
 * no User table. Dropped in the login-simplification round (see CR4 of the
 * corrected work plan) after confirming the prior JWT session token was
 * issued but never consumed by any route guard. */
@Module({
  controllers: [AuthController],
  providers: [AdoPatProvider, Reflector],
  exports: [AdoPatProvider],
})
export class AuthModule {}
