/**
 * Environment/config loader for the ADO MCP server.
 *
 * All values come from the process environment (or docker-compose env_file) —
 * never hardcode org URLs, project names, or credentials here.
 */
export interface AdoMcpConfig {
  /**
   * Optional fallback project, used ONLY when a caller omits the per-request
   * `project` override. Confirmed dead for normal operation: the
   * orchestrator now threads the job's real ADO project through every
   * single call (see mcp.client.ts and jobs.service.ts) -- this is defense
   * against a caller that somehow forgets to, not a real configured
   * default. Optional/unset is fine; a request with no project anywhere
   * fails loudly (a malformed "undefined" URL segment ADO itself rejects)
   * rather than silently resolving against the wrong project.
   */
  adoProject?: string;
  /**
   * api-version fallback ladder, tried in order. Confirmed against a real
   * on-prem Azure DevOps Server 2022.1: its GA REST API tops out at 7.0 —
   * 7.1 exists only as a preview resource there and is rejected outright
   * (VssInvalidPreviewVersionException) unless requested as "7.1-preview".
   * 7.0 is tried before 5.1 so a real 2022.1-class server resolves to its
   * correct GA version rather than falling further than necessary.
   */
  apiVersionLadder: string[];
  /** Path to a CA bundle for on-prem self-signed TLS (NODE_EXTRA_CA_CERTS-style trust). */
  caCertPath?: string;
  /** Batch size for `_apis/wit/workitemsbatch` reads. ADO caps this at 200. */
  batchSize: number;
  /** Bounded concurrency for parallel ADO calls. */
  concurrency: number;
  /** Bearer token required on every MCP HTTP request. */
  mcpBearer: string;
  /** HTTP port for the Streamable HTTP transport. */
  port: number;
  /** 'real' talks to on-prem ADO; 'mock' uses the local SQLite/JSON backend for off-network dev. */
  backend: 'real' | 'mock';
  /** Path to the mock backend's SQLite file (only used when backend === 'mock'). */
  mockDbPath: string;
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadConfig(): AdoMcpConfig {
  const backend = (process.env.ADO_BACKEND ?? 'mock') as 'real' | 'mock';

  return {
    adoProject: process.env.ADO_PROJECT,
    apiVersionLadder: (process.env.ADO_API_VERSION_LADDER ?? '7.1,7.0,5.1,none').split(','),
    caCertPath: process.env.ADO_CA_CERT,
    batchSize: Number(process.env.ADO_BATCH_SIZE ?? 200),
    concurrency: Number(process.env.ADO_CONCURRENCY ?? 8),
    mcpBearer: requireEnv('MCP_BEARER', backend === 'mock' ? 'dev-local-only' : undefined),
    port: Number(process.env.PORT ?? 4100),
    backend,
    mockDbPath: process.env.MOCK_DB_PATH ?? './.req2ado/mock_ado.sqlite',
  };
}
