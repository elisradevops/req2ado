import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface RequestWithAuthHeader {
  headers: { authorization?: string };
}

/**
 * Service-to-service auth for /llm/chat: the caller is the Python ingestion
 * service, not a browser session, so this checks a static bearer token
 * (LLM_PROXY_BEARER) rather than the (separately incomplete, documented-gap)
 * user-session JWT guard. Mirrors the existing MCP_BEARER convention.
 */
@Injectable()
export class LlmProxyBearerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAuthHeader>();
    const header = request.headers.authorization;
    const expected = `Bearer ${this.config.get<string>('LLM_PROXY_BEARER')}`;
    if (header !== expected) {
      throw new UnauthorizedException('Invalid or missing LLM proxy bearer token');
    }
    return true;
  }
}
