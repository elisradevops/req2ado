import { BadRequestException, Controller, Get, Optional, Post, Body, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { CredentialVaultService, userOwnerKey } from '../auth/credential-vault.service';
import { LlmConfigResolver } from '../auth/llm-config.resolver';
import { OpenWebUiClientFactory } from './openwebui-client.factory';
import { ModelHealthService } from './model-health.service';
import { llmConnectionRequestSchema } from './llm-connection.dto';

export interface LlmConnectionStatus {
  configured: boolean;
  chatModel?: string;
  visionModel?: string;
}

/**
 * Session-authenticated (unlike LlmController, which is shared-bearer
 * service-to-service traffic) -- backs Settings' Open WebUI Integrations
 * row: viewing/rotating the caller's own vaulted token + default chat/
 * vision model. Never returns the token itself (GET), and validates a
 * candidate token live against the real catalog before ever storing it
 * (POST) -- same "validate before store" pattern as kb.service.ts's
 * reconnectSharePointToken(), so a bad paste can't clobber a working
 * config.
 *
 * Vision resolution rule (also documented on StoredLlmProfile): a caller
 * that omits visionModel is understood to mean "my chat model already
 * covers vision" -- callers resolve vision calls as
 * `profile.visionModel ?? profile.chatModel`.
 */
@Controller('llm/connection')
export class LlmConnectionController {
  constructor(
    private readonly vault: CredentialVaultService,
    private readonly llmConfigResolver: LlmConfigResolver,
    private readonly clientFactory: OpenWebUiClientFactory,
    @Optional() private readonly modelHealth?: ModelHealthService,
  ) {}

  @Get()
  async getConnection(@CurrentUser() user: SessionUser): Promise<LlmConnectionStatus> {
    const profile = await this.llmConfigResolver.resolve(user.userId);
    if (!profile) return { configured: false };
    return { configured: true, chatModel: profile.chatModel, ...(profile.visionModel ? { visionModel: profile.visionModel } : {}) };
  }

  // `token` query param previews a candidate token that isn't stored yet
  // (Settings' dialog needs to populate the chat/vision model dropdowns as
  // soon as the user pastes a token, before they've saved anything). Falls
  // back to the caller's already-stored token when omitted, for refreshing
  // the dropdowns on an existing connection.
  @Get('models')
  async getModels(
    @CurrentUser() user: SessionUser,
    @Query('token') token: string | undefined,
  ): Promise<{ models: { id: string; name: string; vision: boolean }[] }> {
    if (token) {
      const models = await this.clientFactory.listModelsForToken(token);
      return { models: (await this.modelHealth?.filterVisible(user.userId, models)) ?? models };
    }
    const profile = await this.llmConfigResolver.resolve(user.userId);
    if (!profile) {
      throw new BadRequestException('No Open WebUI connection configured -- pass a token to preview models before saving one');
    }
    const models = await this.clientFactory.listModelsForToken(profile.apiKey);
    return { models: (await this.modelHealth?.filterVisible(user.userId, models)) ?? models };
  }

  @Post()
  async setConnection(@CurrentUser() user: SessionUser, @Body() rawBody: unknown): Promise<{ ok: true }> {
    const parseResult = llmConnectionRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: apiKey and chatModel are required, visionModel is optional');
    }
    const body = parseResult.data;

    let catalog: { id: string; name: string; vision: boolean }[];
    try {
      catalog = await this.clientFactory.listModelsForToken(body.apiKey);
    } catch {
      throw new BadRequestException('Could not validate this Open WebUI token -- check it is correct and try again');
    }
    if (!catalog.some((m) => m.id === body.chatModel)) {
      throw new BadRequestException(`chatModel "${body.chatModel}" is not a selectable model for this token`);
    }
    if (body.visionModel && !catalog.some((m) => m.id === body.visionModel)) {
      throw new BadRequestException(`visionModel "${body.visionModel}" is not a selectable model for this token`);
    }

    await this.vault.set(
      userOwnerKey(user.userId),
      'llm_api_key',
      JSON.stringify({ apiKey: body.apiKey, chatModel: body.chatModel, ...(body.visionModel ? { visionModel: body.visionModel } : {}) }),
    );
    // Without this, a cached client from before this change (old token,
    // old model) would keep serving this user's requests until process
    // restart -- same hazard getClientFor()'s own doc comment describes.
    this.clientFactory.invalidate(user.userId);
    return { ok: true };
  }
}
