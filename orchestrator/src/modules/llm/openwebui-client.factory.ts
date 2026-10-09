import { isModelHidden, parseModelHidePatterns } from './model-visibility';
import { Injectable } from '@nestjs/common';
import { LlmConfigResolver } from '../auth/llm-config.resolver';
import { OpenWebUiClient, type OpenWebUiClientConfig } from './openwebui.client';

export type OpenWebUiGlobalConfig = Omit<OpenWebUiClientConfig, 'LLM_API_KEY' | 'LLM_CHAT_MODEL' | 'LLM_VISION_MODEL'>;

/**
 * Keyed replacement for the process-lifetime singleton OpenWebUiClient
 * (previously constructed once in llm.module.ts and again, separately, in
 * pipeline.processor.ts). Every user now has their own Open WebUI token and
 * default chat/vision model (see llm-config.resolver.ts); a shared client
 * would either use the wrong user's credential or require resolving/
 * reconstructing one on every call, so this factory does the resolve-and-
 * cache once per user instead.
 *
 * Base URL and the various native-path/embed fields (EMBED_*, SHOW_PATH,
 * FILES_*_PATH, LLM_TRUSTED_LOCAL, LLM_REQUEST_TIMEOUT_MS) stay global,
 * per this project's decision that one Open WebUI instance serves every
 * user on a deployment -- only the token and the two model fields vary
 * per user.
 *
 * Throws when the user has no vaulted profile (hard-fail, matching this
 * project's decision to require per-user configuration rather than
 * silently falling back to a removed global default) -- see
 * llm-config.resolver.ts's own doc comment.
 *
 * Takes the resolved global config as a plain object, NOT a NestJS
 * ConfigService -- pipeline.processor.ts constructs this directly (it runs
 * in a BullMQ sandboxed child process with no NestJS DI container of its
 * own, same reason every other client there is `new`'d rather than
 * injected) and has no ConfigService instance to hand it. llm.module.ts's
 * own provider registration builds this same shape from its ConfigService
 * via a useFactory, matching this module's existing convention for every
 * other config-carrying provider (see e.g. JobsModule's EtaService/
 * BackfillService wiring).
 */
@Injectable()
export class OpenWebUiClientFactory {
  private readonly cache = new Map<string, OpenWebUiClient>();

  constructor(
    private readonly globalConfig: OpenWebUiGlobalConfig,
    private readonly llmConfigResolver: LlmConfigResolver,
  ) {}

  async getClientFor(userId: string): Promise<OpenWebUiClient> {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const profile = await this.llmConfigResolver.resolve(userId);
    if (!profile) {
      throw new Error(`User ${userId} has no Open WebUI connection configured -- set one in Settings before running a job`);
    }
    const client = new OpenWebUiClient({
      ...this.globalConfig,
      LLM_API_KEY: profile.apiKey,
      LLM_CHAT_MODEL: profile.chatModel,
      LLM_VISION_MODEL: profile.visionModel,
    });
    this.cache.set(userId, client);
    return client;
  }

  // Called by llm-connection.controller.ts after a user changes their
  // token/model -- without this, a stale cached client (old token, old
  // model) would keep serving that user's requests until process restart.
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private hidePatterns?: RegExp[];

  /** True when LLM_MODEL_HIDE_PATTERNS hides this model (see model-visibility.ts). Global, not per user. */
  isModelHidden(model: string): boolean {
    this.hidePatterns ??= parseModelHidePatterns(this.globalConfig.LLM_MODEL_HIDE_PATTERNS);
    return isModelHidden(model, this.hidePatterns);
  }

  // Builds a throwaway client for a candidate token that ISN'T vaulted yet
  // -- llm-connection.controller.ts's POST /llm/connection validate-before-
  // store flow, and its GET /llm/connection/models preview, both need to
  // list models for a token the user just pasted, before it's ever stored
  // or cached. Never cached (unlike getClientFor) -- this is a one-shot
  // probe, not a client meant to serve ongoing traffic.
  async listModelsForToken(token: string): Promise<{ id: string; name: string; vision: boolean }[]> {
    const client = new OpenWebUiClient({ ...this.globalConfig, LLM_API_KEY: token, LLM_CHAT_MODEL: '' });
    return client.listSelectableModels(token);
  }
}
