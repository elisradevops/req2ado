import { Controller, Get } from '@nestjs/common';
import { OpenWebUiClient } from './openwebui.client';

export interface LlmStatus {
  status: 'reachable' | 'unreachable';
  latencyMs: number;
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
  constructor(private readonly llmClient: OpenWebUiClient) {}

  @Get('status')
  async getStatus(): Promise<LlmStatus> {
    return this.llmClient.checkHealth();
  }
}
