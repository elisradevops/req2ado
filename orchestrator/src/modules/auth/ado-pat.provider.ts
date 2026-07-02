import { Injectable } from '@nestjs/common';

/**
 * `identity` is `authenticatedUser.descriptor` from ADO's connectionData
 * response — stable, unique, and NOT the PAT itself (confirmed via research:
 * survives display-name/email changes, unlike providerDisplayName or
 * properties.Account.$value). Use this as the DB key, never displayName.
 */
export interface AdoIdentity {
  identity: string;
  displayName: string;
}

function buildBasicAuthHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

@Injectable()
export class AdoPatProvider {
  /**
   * Validates a PAT by calling ADO's own connectionData endpoint — the same
   * call the mock/real ADO backend already treats as a liveness/identity
   * check (see mcp-ado-server's ado_ping tool). No separate identity
   * provider is needed: on-prem ADO Server itself is the identity source.
   */
  async validateAndIdentify(orgUrl: string, pat: string): Promise<AdoIdentity> {
    const url = `${orgUrl.replace(/\/$/, '')}/_apis/connectionData?api-version=7.1`;
    const response = await fetch(url, {
      headers: { Authorization: buildBasicAuthHeader(pat) },
    });

    if (!response.ok) {
      throw new Error(`ADO connectionData validation failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      authenticatedUser?: { descriptor?: string; providerDisplayName?: string };
    };
    const descriptor = body.authenticatedUser?.descriptor;
    if (!descriptor) {
      throw new Error('ADO connectionData response missing authenticatedUser.descriptor');
    }

    return {
      identity: descriptor,
      displayName: body.authenticatedUser?.providerDisplayName ?? descriptor,
    };
  }
}
