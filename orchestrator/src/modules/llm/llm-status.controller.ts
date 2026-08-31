import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { OpenWebUiClientFactory } from './openwebui-client.factory';

export interface LlmStatus {
  status: 'reachable' | 'unreachable' | 'not_configured';
  latencyMs: number | null;
}

// Deliberately a SEPARATE controller from LlmController, not a new route on
// it -- LlmController is @UseGuards(LlmProxyBearerGuard)-gated internal
// service-to-service traffic (ingestion's shared bearer token), while this
// is browser-facing, session-cookie-authenticated traffic for the sidebar's
// connection-status LED, same convention as AdoController.getStatus/
// KbController's sharepoint/status route. Sharing the same 'llm' path
// prefix as LlmController is safe -- @UseGuards is per-controller-class, it
// never leaks across two controller classes merely sharing a base path,
// and 'status' doesn't collide with any of LlmController's own routes.
@Controller('llm')
export class LlmStatusController {
  constructor(private readonly clientFactory: OpenWebUiClientFactory) {}

  // Unlike LlmController.resolveClient(), a user with no Open WebUI
  // connection configured yet is not an error here -- this is a status
  // check the sidebar polls on every page, including before first-login
  // configuration, so it must degrade to a status value, never throw/401.
  @Get('status')
  async getStatus(@CurrentUser() user: SessionUser): Promise<LlmStatus> {
    try {
      const client = await this.clientFactory.getClientFor(user.userId);
      return await client.checkHealth();
    } catch {
      return { status: 'not_configured', latencyMs: null };
    }
  }
}
