import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from './session.service';

/** The authenticated caller's identity, set by AuthGuard on the request before any handler runs -- never client-supplied. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionUser => {
  const request = ctx.switchToHttp().getRequest<Request & { user: SessionUser }>();
  return request.user;
});
