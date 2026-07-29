import { Injectable } from '@nestjs/common';
import { CredentialVaultService, userOwnerKey } from './credential-vault.service';

export interface StoredAdoCredential {
  orgUrl: string;
  pat: string;
}

/**
 * Resolves a user's stored ADO credential (vaulted at login/reconnect time,
 * see auth.controller.ts) -- replaces every previous `@Headers('x-ado-pat')`
 * call site, which required the browser to resend the PAT on every
 * write-triggering request. Returns undefined (not an error) when the user
 * has no stored credential -- callers already treat "no credential" as
 * "fall back to mock backend / can't write to real ADO", the same
 * degraded behavior as before a credential existed.
 */
@Injectable()
export class AdoCredentialResolver {
  constructor(private readonly vault: CredentialVaultService) {}

  async resolve(userId: string): Promise<StoredAdoCredential | undefined> {
    const raw = await this.vault.get(userOwnerKey(userId), 'ado_pat');
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredAdoCredential;
    } catch {
      return undefined;
    }
  }
}
