import { BadRequestException, Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AdoPatProvider } from './ado-pat.provider';
import { loginRequestSchema } from './login.dto';
import { SessionService, type SessionUser } from './session.service';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import { CredentialVaultService, userOwnerKey } from './credential-vault.service';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from './session.constants';

// `Secure` behind a config flag -- this deploys over plain HTTP on-prem
// (see docs/architecture.md), so hardcoding Secure would break every
// on-prem login. `SameSite=Lax` (not Strict) so a same-site top-level
// navigation (e.g. a bookmarked link) still carries the cookie.
function cookieOptions(): { httpOnly: true; sameSite: 'lax'; secure: boolean; maxAge: number; path: string } {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly adoPatProvider: AdoPatProvider,
    private readonly sessionService: SessionService,
    private readonly credentialVault: CredentialVaultService,
  ) {}

  /**
   * The ADO org URL + PAT are still the identity source (AdoPatProvider,
   * unchanged) -- this route proves the credential works, issues a real
   * server session on top of that proven identity, AND vaults the PAT
   * (encrypted, keyed to this userId) so it never needs to be resent by the
   * browser again. orgUrl is stored alongside it (not secret, but needed
   * together with the PAT for every ADO call) -- see AdoCredentialResolver.
   *
   * Rate-limited separately from the app-wide 200/60s default: this is now
   * a session-issuing, credential-storing endpoint, worth a tighter per-IP
   * cap against credential-guessing.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ displayName: string; userId: string }> {
    const parseResult = loginRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: adoOrgUrl must be a valid URL, pat must be non-empty');
    }
    const body = parseResult.data;

    try {
      const identity = await this.adoPatProvider.validateAndIdentify(body.adoOrgUrl, body.pat);
      const token = await this.sessionService.create(identity.identity, identity.displayName);
      const ownerKey = userOwnerKey(identity.identity);
      await this.credentialVault.set(ownerKey, 'ado_pat', JSON.stringify({ orgUrl: body.adoOrgUrl, pat: body.pat }));
      res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
      return { displayName: identity.displayName, userId: identity.identity };
    } catch {
      throw new UnauthorizedException('Invalid ADO organization URL or Personal Access Token');
    }
  }

  /**
   * Re-validates and re-vaults a rotated PAT (or a corrected org URL)
   * WITHOUT issuing a new session -- the caller is already signed in
   * (AuthGuard applies here, unlike /auth/login). Used by the Settings
   * "Reconnect" action so rotating a PAT doesn't force a full sign-out.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('ado-credential')
  async updateAdoCredential(
    @CurrentUser() user: SessionUser,
    @Body() rawBody: unknown,
  ): Promise<{ ok: true }> {
    const parseResult = loginRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: adoOrgUrl must be a valid URL, pat must be non-empty');
    }
    const body = parseResult.data;
    try {
      const identity = await this.adoPatProvider.validateAndIdentify(body.adoOrgUrl, body.pat);
      if (identity.identity !== user.userId) {
        // The re-entered PAT belongs to a DIFFERENT ADO identity than the
        // one this session was issued for -- reject rather than silently
        // re-keying the session's stored credential to someone else's PAT.
        throw new UnauthorizedException('This Personal Access Token belongs to a different ADO account than the current session.');
      }
      await this.credentialVault.set(userOwnerKey(user.userId), 'ado_pat', JSON.stringify({ orgUrl: body.adoOrgUrl, pat: body.pat }));
      return { ok: true };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid ADO organization URL or Personal Access Token');
    }
  }

  /**
   * Public (no AuthGuard) -- this IS the bootstrap check RouteGuard calls
   * on every app load, so it must never itself require a valid session to
   * answer. Returns `authenticated: false` for a missing/expired/invalid
   * cookie, never a 401 -- an absent session is this route's normal,
   * expected response, not an error.
   */
  @Public()
  @Get('me')
  async me(@Req() req: Request): Promise<{ authenticated: boolean; userId?: string; displayName?: string }> {
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (!token) return { authenticated: false };
    const user = await this.sessionService.validate(token);
    if (!user) return { authenticated: false };
    return { authenticated: true, userId: user.userId, displayName: user.displayName };
  }

  /**
   * Public: logout must succeed even against an already-expired/invalid
   * session (still clears the cookie either way) -- gating this behind
   * AuthGuard would 401 the very request meant to clean up a dead session.
   */
  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (token) {
      await this.sessionService.revoke(token);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }
}

export type { SessionUser };
