import type { AdoRequestCredential } from './mcp.client';

export function readAdoCredential(orgUrl: string | undefined, pat: string | undefined): AdoRequestCredential | undefined {
  return orgUrl && pat ? { orgUrl, pat } : undefined;
}
