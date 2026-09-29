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

// connectionData is a PREVIEW-classified resource in the ADO Location service —
// it requires the -preview suffix regardless of server version. Requesting it
// with a plain GA version (e.g. 7.1) returns 400 VssInvalidPreviewVersionException
// even on servers whose latest GA REST API version is 7.2. Confirmed live against
// on-prem Azure DevOps Server 2022.x:
//   connectionData?api-version=7.1         → 400 (preview flag required)
//   connectionData?api-version=7.1-preview → 200 ✅
// The ladder tries preview versions newest-first; a 400 advances to the next
// entry (wrong preview version for this server). A non-400 failure (401 bad PAT,
// TLS error, etc.) breaks immediately — retrying versions cannot fix those.
const CONNECTION_DATA_VERSION_LADDER = ['7.2-preview', '7.1-preview', '6.0-preview', 'none'];

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

    for (const version of CONNECTION_DATA_VERSION_LADDER) {
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
      // Attempt to extract ADO's structured error fields (typeKey / message)
      // so a VssInvalidPreviewVersionException 400 is clearly distinguishable
      // from a real 401 auth failure in the logs — both previously appeared
      // identical to callers.
      let errorDetail = '';
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        const typeKey = typeof parsed.typeKey === 'string' ? parsed.typeKey : '';
        const message = typeof parsed.message === 'string' ? parsed.message : '';
        if (typeKey || message) errorDetail = ` [${typeKey}] ${message}`.trimEnd();
      } catch {
        // non-JSON body — errorDetail stays empty, raw bodyText logged below
      }
      lastFailure = { status: response.status, url, bodyText: errorDetail || bodyText };

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
