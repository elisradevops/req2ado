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

// Mirrors mcp-ado-server's own api-version ladder (src/config/env.ts) —
// confirmed against a real on-prem Azure DevOps Server 2022.1: its GA REST
// API tops out at 7.0. 7.1 is preview-only there and is REJECTED with a 400
// VssInvalidPreviewVersionException, not authenticated at all. Only a 400
// advances to the next version in the ladder; a 401 means the PAT itself
// is bad/expired and must fail immediately — retrying other api-versions
// would never fix an auth problem and would only hide the real error.
const API_VERSION_LADDER = ['7.1', '7.0', '5.1', 'none'];

function connectionDataUrl(orgUrl: string, version: string): string {
  const base = `${orgUrl.replace(/\/$/, '')}/_apis/connectionData`;
  return version === 'none' ? base : `${base}?api-version=${version}`;
}

@Injectable()
export class AdoPatProvider {
  /**
   * Validates a PAT by calling ADO's own connectionData endpoint — the same
   * call the mock/real ADO backend already treats as a liveness/identity
   * check (see mcp-ado-server's ado_ping tool). No separate identity
   * provider is needed: on-prem ADO Server itself is the identity source.
   *
   * TLS: on-prem ADO Server deployments commonly present a self-signed
   * certificate. Per the architecture's locked decision (docs/architecture.md
   * "on-prem TLS = CA-trust"), trust is established via the `NODE_EXTRA_CA_CERTS`
   * environment variable pointed at the CA bundle referenced by `ADO_CA_CERT`,
   * set at container/process launch — NOT by disabling certificate verification
   * and NOT consumed directly in this file. This mirrors the same deferred
   * pattern `mcp-ado-server` uses for its own `caCertPath` config field
   * (see mcp-ado-server/src/config/env.ts). A custom TLS agent/dispatcher is
   * out of scope for this round.
   */
  async validateAndIdentify(orgUrl: string, pat: string): Promise<AdoIdentity> {
    const authHeader = buildBasicAuthHeader(pat);
    let lastFailure: { status: number; url: string; bodyText: string } | null = null;

    for (const version of API_VERSION_LADDER) {
      const url = connectionDataUrl(orgUrl, version);
      const response = await fetch(url, { headers: { Authorization: authHeader } });

      if (response.ok) {
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

      const bodyText = await response.text().catch(() => '<unreadable body>');
      lastFailure = { status: response.status, url, bodyText };

      // Only a 400 (e.g. VssInvalidPreviewVersionException) means THIS
      // api-version is wrong for this server — try the next one. Any other
      // status (401 expired/invalid PAT, network error, etc.) is not fixed
      // by trying a different api-version — fail immediately with the real
      // error rather than exhausting the whole ladder pointlessly.
      if (response.status !== 400) {
        break;
      }
    }

    // Diagnostic logging — never logs the PAT itself, only the ADO server's
    // own response, which is what actually explains login failures (expired
    // PAT, wrong api-version, network/TLS issues) that a bare "Unauthorized"
    // from this route would otherwise hide completely.
    // eslint-disable-next-line no-console
    console.error(
      `ADO connectionData validation failed: ${lastFailure?.status} at ${lastFailure?.url}\nBody (first 500 chars): ${lastFailure?.bodyText.slice(0, 500)}`,
    );
    throw new Error(`ADO connectionData validation failed: ${lastFailure?.status}`);
  }
}
