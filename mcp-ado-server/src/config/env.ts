/**
 * Environment/config loader for the ADO MCP server.
 *
 * All values come from the process environment (or docker-compose env_file) —
 * never hardcode org URLs, project names, or credentials here.
 */
export interface AdoMcpConfig {
  /** On-prem ADO/TFS org base URL, e.g. https://tfs.internal/tfs/Collection */
  adoBaseUrl: string;
  /** Target project name. */
  adoProject: string;
  /** api-version fallback ladder, tried in order. On-prem ADO Server tops out at 7.1. */
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
    adoBaseUrl: backend === 'real' ? requireEnv('ADO_BASE_URL') : (process.env.ADO_BASE_URL ?? ''),
    adoProject: backend === 'real' ? requireEnv('ADO_PROJECT') : (process.env.ADO_PROJECT ?? ''),
    apiVersionLadder: (process.env.ADO_API_VERSION_LADDER ?? '7.1,5.1,none').split(','),
    caCertPath: process.env.ADO_CA_CERT,
    batchSize: Number(process.env.ADO_BATCH_SIZE ?? 200),
    concurrency: Number(process.env.ADO_CONCURRENCY ?? 8),
    mcpBearer: requireEnv('MCP_BEARER', backend === 'mock' ? 'dev-local-only' : undefined),
    port: Number(process.env.PORT ?? 4100),
    backend,
    mockDbPath: process.env.MOCK_DB_PATH ?? './.req2ado/mock_ado.sqlite',
  };
}
