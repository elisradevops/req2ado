/**
 * PAT auth helpers for on-prem ADO/TFS.
 *
 * ADO's REST API accepts a Personal Access Token via HTTP Basic auth with an
 * empty username: `Authorization: Basic base64(":" + pat)`. This mirrors the
 * pattern already used elsewhere in the workspace (see docs/architecture.md
 * "Generic ADO REST conventions reused as knowledge").
 */

/** Builds the `Authorization` header value for a raw PAT. */
export function buildBasicAuthHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

/**
 * The PAT never comes from env/config in this app — it is supplied per-request
 * by the orchestrator (which in turn got it from the user's login-screen
 * session). This type documents that contract at the MCP boundary.
 */
export interface AdoCredential {
  orgUrl: string;
  pat: string;
}
