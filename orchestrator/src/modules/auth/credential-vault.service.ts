import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { decryptCredential, encryptCredential } from './credential-crypto';

export type CredentialKind = 'ado_pat' | 'sharepoint_token' | 'llm_api_key';

// The one shared SharePoint identity's owner key -- matches today's design
// (docs/architecture.md: SharePoint stays a single shared server identity,
// per-user delegated Graph tokens need an App Registration this deployment
// doesn't have). Any authenticated user can rotate it (see kb.controller.ts).
export const SHARED_OWNER_KEY = 'shared';

export function userOwnerKey(userId: string): string {
  return `user:${userId}`;
}

/**
 * Server-side encrypted credential store. Replaces two prior patterns:
 * (1) the ADO PAT being resent by the browser on every write-triggering
 * request, (2) the SharePoint token / LLM key living only in a shared
 * server env var with no rotation UI. Encryption key comes from
 * CREDENTIAL_ENC_KEY, with an optional CREDENTIAL_ENC_KEY_PREVIOUS for
 * rotation: get() tries the current key first, falls back to the previous
 * key on decrypt failure (mismatched auth tag), and re-encrypts under the
 * current key on successful fallback so rows migrate to the new key
 * lazily instead of needing a big-bang migration script.
 */
@Injectable()
export class CredentialVaultService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptionKey: string,
    private readonly previousEncryptionKey?: string,
  ) {}

  async set(ownerKey: string, kind: CredentialKind, plaintext: string): Promise<void> {
    const payload = encryptCredential(plaintext, ownerKey, kind, this.encryptionKey);
    await this.prisma.externalCredential.upsert({
      where: { ownerKey_kind: { ownerKey, kind } },
      create: { ownerKey, kind, ...payload, keyVersion: 1 },
      update: { ...payload, keyVersion: 1 },
    });
  }

  async get(ownerKey: string, kind: CredentialKind): Promise<string | null> {
    const row = await this.prisma.externalCredential.findUnique({ where: { ownerKey_kind: { ownerKey, kind } } });
    if (!row) return null;
    const payload = { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag };
    try {
      return decryptCredential(payload, ownerKey, kind, this.encryptionKey);
    } catch (currentKeyError) {
      if (!this.previousEncryptionKey) throw currentKeyError;
      const plaintext = decryptCredential(payload, ownerKey, kind, this.previousEncryptionKey);
      // Lazy re-encryption under the current key -- next read no longer
      // needs the fallback. Best-effort: if this write fails, the value
      // just gets re-migrated on the next read instead of failing the
      // current request, which already has its answer.
      await this.set(ownerKey, kind, plaintext).catch(() => undefined);
      return plaintext;
    }
  }

  async delete(ownerKey: string, kind: CredentialKind): Promise<void> {
    await this.prisma.externalCredential.deleteMany({ where: { ownerKey, kind } });
  }

  async has(ownerKey: string, kind: CredentialKind): Promise<boolean> {
    const row = await this.prisma.externalCredential.findUnique({
      where: { ownerKey_kind: { ownerKey, kind } },
      select: { id: true },
    });
    return row !== null;
  }
}
