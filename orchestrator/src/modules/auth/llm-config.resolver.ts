import { Injectable } from '@nestjs/common';
import { CredentialVaultService, userOwnerKey } from './credential-vault.service';

export interface StoredLlmProfile {
  apiKey: string;
  chatModel: string;
  // Omitted means the chat model is itself vision-capable and serves both
  // roles -- see llm-connection.controller.ts's own doc comment for the
  // full resolution rule callers must follow.
  visionModel?: string;
}

/**
 * Resolves a user's stored Open WebUI connection (vaulted via
 * llm-connection.controller.ts's POST /llm/connection) -- same storage
 * pattern as AdoCredentialResolver: one JSON blob under the existing
 * ExternalCredential 'llm_api_key' kind (see credential-vault.service.ts),
 * not a new table. Returns undefined (not an error) when the user has no
 * stored profile -- callers must treat "no profile" as "this user hasn't
 * configured Open WebUI yet" and hard-fail the calling operation rather
 * than silently falling back to a shared/global credential (LLM_API_KEY/
 * LLM_VISION_MODEL as global env vars are retired entirely; LLM_CHAT_MODEL
 * survives only as pipeline.worker.ts's fallback-of-last-resort when THIS
 * resolution itself fails -- see that file's own resolveDefaultChatModel
 * doc comment).
 */
@Injectable()
export class LlmConfigResolver {
  constructor(private readonly vault: CredentialVaultService) {}

  async resolve(userId: string): Promise<StoredLlmProfile | undefined> {
    const raw = await this.vault.get(userOwnerKey(userId), 'llm_api_key');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredLlmProfile;
    } catch {
      return undefined;
    }
  }
}
