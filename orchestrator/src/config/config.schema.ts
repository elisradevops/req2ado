import { z } from 'zod';

/**
 * Validated shape of process.env for the orchestrator. Fields mirror
 * `config.yaml` / `.env.template` at the repo root — see docs/architecture.md
 * section 2b. Anything missing here throws at boot, not at first use.
 */
export const configSchema = z.object({
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MCP_URL: z.string().min(1),
  MCP_BEARER: z.string().min(1),
  // Wall-clock cap (ms) on a single MCP round trip (connect + tool call +
  // close) in McpClient.withClient. Prevents a crashed/hung mcp-ado-server
  // from wedging a pipeline job in 'running' indefinitely (the promise never
  // settling made the surrounding try/catch never fire). Matches the MCP
  // SDK's own 60s request default.
  MCP_REQUEST_TIMEOUT_MS: z.coerce.number().default(60000),
  ADO_CA_CERT: z.string().optional(),
  LLM_BASE_URL: z.string().min(1),
  LLM_API_KEY: z.string().optional(),
  LLM_CHAT_MODEL: z.string().min(1),
  // Optional: a vision-capable model (e.g. llava, bakllava, moondream) for
  // describing figures/diagrams during ingestion (see OpenWebUiClient.vision).
  // Unset means figures stay as empty placeholders -- same behavior as
  // before this option existed.
  LLM_VISION_MODEL: z.string().optional(),
  LLM_TRUSTED_LOCAL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LLM_PROXY_BEARER: z.string().min(1),
  EMBED_TRANSPORT: z.enum(['ollama', 'openai']).default('ollama'),
  EMBED_BASE_URL: z.string().optional(),
  EMBED_MODEL: z.string().min(1),
  EMBED_PATH: z.string().default('/api/embed'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(25),
  // Initial System.State written on every created work item. Hardcoded
  // 'Proposed' previously -- an on-prem custom process template without
  // that state would fail every create. Configurable per-deployment.
  ADO_INITIAL_STATE: z.string().default('Proposed'),
  // Comma-separated candidate field ref names tried, in order, for the
  // Customer ID custom field (see JobsService.resolveCustomerIdField).
  // Previously hardcoded to a fixed 3-name list with no way to add an
  // org-specific field name without a code change. Unset keeps the exact
  // previous default list.
  CUSTOMER_ID_FIELD_CANDIDATES: z.string().optional(),
  // Bounded concurrency for confirm()'s work-item create/link calls --
  // previously fully sequential (one ADO round-trip at a time), meaning a
  // tree of hundreds of nodes took ~2N serial round-trips with no way to
  // speed it up. Default matches mcp-ado-server's own ADO_CONCURRENCY.
  CONFIRM_WRITE_CONCURRENCY: z.coerce.number().default(8),
  // How many BullMQ pipeline jobs pipeline-worker.main.ts processes
  // concurrently -- previously unset (bullmq's own implicit default is 1),
  // a real horizontal-scaling throughput blocker even before considering
  // running multiple worker replicas. Default of 4 balances SURVEY jobs'
  // real CPU/memory cost (OCR, LLM proxy round-trips) against not leaving
  // real concurrency on the table for the common case of several BASELINE
  // jobs queued at once.
  PIPELINE_WORKER_CONCURRENCY: z.coerce.number().default(4),
  INGESTION_BASE_URL: z.string().min(1).default('http://localhost:8000'),
  // Unset in production topology (frontend served same-origin behind nginx,
  // per docs/architecture.md — never actually built, see docker-compose.yml's
  // commented-out frontend service). Set for local dev, where Vite serves the
  // frontend on its own origin/port (5173) against this API (3001).
  CORS_ORIGIN: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
