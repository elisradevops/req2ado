import { CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SessionService, type SessionUser } from './session.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SESSION_COOKIE_NAME } from './session.constants';

/**
 * Global guard (registered as APP_GUARD in AppModule) -- a new controller
 * is protected by default; @Public() is the explicit opt-out, not the
 * other way around. Reads the session cookie (cookie-parser middleware,
 * wired in main.ts, must run before this) rather than a bearer header --
 * this is what makes SSE (EventSource can't set headers) and the WS
 * handshake authenticable at all under the same session model.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessionService: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const token = request.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (!token) {
      throw new UnauthorizedException('Not signed in');
    }
    const user = await this.sessionService.validate(token);
    if (!user) {
      throw new UnauthorizedException('Session expired or invalid');
    }
    request.user = user;
    return true;
  }
}
