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
  // Explicit timeout (ms) for the OpenAI SDK client used by chat()/streamChat()/
  // vision() -- previously relied on the SDK's own undocumented 600000ms
  // default AND its default maxRetries:2, which together silently re-ran a
  // whole >10min inference up to 3 times on timeout before giving up (the
  // actual root cause of job a830aa30's ~66min failure, not a missing retry
  // -- see OpenWebUiClient's own maxRetries:0 comment). Same numeric default
  // as before (no behavior change to the timeout itself), now explicit and
  // configurable so it can be tuned without a code change. Sits below
  // ingestion's own _LLM_REQUEST_TIMEOUT_SECONDS (30 min) and this
  // orchestrator's IngestionHttpClient LONG_RUNNING_AGENT (1h), so the
  // innermost hop always fails first with real margin to spare.
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().default(600_000),
  EMBED_TRANSPORT: z.enum(['ollama', 'openai']).default('ollama'),
  EMBED_BASE_URL: z.string().optional(),
  EMBED_MODEL: z.string().min(1),
  EMBED_PATH: z.string().default('/api/embed'),
  // Same "raw Ollama vs Open WebUI proxy" path distinction EMBED_PATH
  // already exists for -- Open WebUI does not expose a bare /api/show at
  // all (405 Method Not Allowed, confirmed live), only /ollama/api/show
  // (its own Ollama-native-API proxy prefix). Default assumes a direct
  // Ollama backend (this codebase's original target); set to
  // /ollama/api/show when LLM_BASE_URL points at Open WebUI instead.
  SHOW_PATH: z.string().default('/api/show'),
  // Open WebUI's native file-upload + processing-status endpoints, used by
  // OpenWebUiClient.uploadFile/pollFileProcessed/deleteFile for the
  // whole-document AI context primer (Phase 6). FILES_STATUS_PATH is a base
  // path -- callers append `/${id}/process/status` or `/${id}` themselves,
  // same "base + suffix" shape SHOW_PATH's own comment already documents for
  // the raw-Ollama-vs-Open-WebUI-proxy distinction.
  FILES_UPLOAD_PATH: z.string().default('/api/v1/files/'),
  FILES_STATUS_PATH: z.string().default('/api/v1/files'),
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
  // StaleJobWatchdogService's poll interval and staleness threshold -- a
  // pending/running job with no JobEvent activity for longer than the
  // threshold gets auto-cancelled (see that service's own doc comment for
  // why). Threshold default (60 min) sits comfortably above the single-call
  // LLM timeout (_LLM_REQUEST_TIMEOUT_SECONDS, ingestion-side, 30 min) so it
  // never fires on a legitimately slow-but-alive call.
  STALE_JOB_CHECK_INTERVAL_MS: z.coerce.number().default(5 * 60_000),
  STALE_JOB_THRESHOLD_MS: z.coerce.number().default(60 * 60_000),
  // JobRetentionService's poll interval and age threshold -- a job in a
  // TERMINAL, no-longer-actionable state (succeeded/failed/rejected/
  // cancelled) older than the threshold (by createdAt -- the only
  // timestamp every job row reliably has; completedAt is succeeded-only)
  // gets permanently deleted along with its cascade children. Never
  // touches pending/running (always active) or diff_ready (still awaiting
  // a real confirm/reject decision) regardless of age. Deliberately
  // excludes IdempotencyMapping/the dedup vector store -- those exist to
  // prevent duplicate ADO writes indefinitely; age-pruning them would let
  // the same content get recreated as a duplicate later.
  JOB_RETENTION_CHECK_INTERVAL_MS: z.coerce.number().default(6 * 60 * 60_000),
  JOB_RETENTION_MAX_AGE_MS: z.coerce.number().default(2 * 24 * 60 * 60_000),
  // How many BullMQ pipeline jobs pipeline-worker.main.ts processes
  // concurrently -- previously unset (bullmq's own implicit default is 1),
  // a real horizontal-scaling throughput blocker even before considering
  // running multiple worker replicas. Default of 4 balances SURVEY jobs'
  // real CPU/memory cost (OCR, LLM proxy round-trips) against not leaving
  // real concurrency on the table for the common case of several BASELINE
  // jobs queued at once.
  PIPELINE_WORKER_CONCURRENCY: z.coerce.number().default(4),
  INGESTION_BASE_URL: z.string().min(1).default('http://localhost:8000'),
  // Outermost timeout (ms) in the SURVEY call ladder (orchestrator ->
  // ingestion -> ingestion's own /llm/chat proxy -> the LLM backend) --
  // see IngestionHttpClient's own doc comment. Deliberately the widest of
  // the three, so an inner layer's timeout always fires first. Same
  // numeric default as before this was configurable (no behavior change).
  INGESTION_REQUEST_TIMEOUT_MS: z.coerce.number().default(3_600_000),
  // Unset in production topology (frontend served same-origin behind nginx,
  // per docs/architecture.md — never actually built, see docker-compose.yml's
  // commented-out frontend service). Set for local dev, where Vite serves the
  // frontend on its own origin/port (5173) against this API (3001).
  CORS_ORIGIN: z.string().optional(),
  // Encrypts every row in ExternalCredential (ADO PAT, SharePoint token,
  // LLM key) -- see credential-vault.service.ts. Required: there is no
  // meaningful default for a secret-encryption key, and running with a
  // hardcoded/well-known key would defeat the vault's whole purpose.
  CREDENTIAL_ENC_KEY: z.string().min(1),
  // Optional: the previous value of CREDENTIAL_ENC_KEY, kept for one
  // rotation cycle. CredentialVaultService.get() falls back to this key on
  // a current-key decrypt failure and lazily re-encrypts under the current
  // key -- rotating CREDENTIAL_ENC_KEY never requires a big-bang migration
  // or invalidates every stored credential at once.
  CREDENTIAL_ENC_KEY_PREVIOUS: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
