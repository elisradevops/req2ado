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
  // Optional: overrides LLM_BASE_URL as the OpenAI SDK's baseURL for chat/completions
  // calls only. Use to switch to Open WebUI's /api/chat path without breaking native-
  // API calls (files, embeddings) which derive their root from LLM_BASE_URL.
  LLM_CHAT_BASE_URL: z.string().optional(),
  // When false (default), seed and reasoning_effort are never sent -- Azure-backed
  // models via LiteLLM reject both with a 400. Set true only for Ollama/compatible
  // backends that accept them.
  LLM_SEND_SEED: z.enum(['true', 'false']).default('false'),
  LLM_SEND_REASONING_EFFORT: z.enum(['true', 'false']).default('false'),
  // Temperature for vision() calls. Unset (default) → no temperature sent,
  // letting the backend model apply its own default or constraint (e.g.
  // claude-opus-4-8 requires temperature=1 for extended thinking -- the
  // parseTemperatureConstraint retry handles that automatically when this is
  // left unset). Set to 0 for deterministic extraction on models that accept
  // it; set to 1 to skip the retry overhead when the target vision model is
  // known to require it.
  LLM_VISION_TEMPERATURE: z.coerce.number().optional(),
  // maxTokens for DocumentOverviewService's pre-job document-summary call
  // (NewJobWizard step 3, "Confirm understanding"). Default raised from the
  // original 300 after live confirmation (finishReason=length in production
  // logs) that a reasoning-capable model can exhaust a small budget on
  // hidden chain-of-thought before emitting any real content -- this
  // deployment has no way to disable that reasoning for this call
  // (LLM_SEND_REASONING_EFFORT is globally false), so a larger budget is the
  // only available lever. 4000 is a reasoned estimate, not empirically
  // confirmed sufficient for every model -- exposed as an env var so it can
  // be retuned without a code change if it recurs.
  DOCUMENT_OVERVIEW_MAX_TOKENS: z.coerce.number().default(4000),
  // NOT the per-user credential any more -- every user has their own
  // vaulted token/chat model/vision model (see llm-config.resolver.ts,
  // openwebui-client.factory.ts). This is now purely a fallback-of-last-
  // resort default model name, read only when a per-user default can't be
  // resolved (pipeline.worker.ts's resolveDefaultChatModel) or for
  // EtaService's pricing-estimate baseline (jobs.module.ts) -- neither of
  // those is the real per-user LLM call itself, which always uses the
  // submitting user's own configured model.
  LLM_CHAT_MODEL: z.string().min(1),
  LLM_TRUSTED_LOCAL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LLM_PROXY_BEARER: z.string().min(1),
  // Job transparency (docs/job-transparency-implementation-plan.md): turns on
  // the counted percentage, the document-map endpoint and the live/progress
  // SSE events. Ships OFF -- with it unset the orchestrator behaves exactly
  // as before. Ingestion has its own LIVE_PROGRESS flag (same name).
  LIVE_PROGRESS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
  // Same override mechanism as CUSTOMER_ID_FIELD_CANDIDATES above, for the
  // picklist-constrained requirement-classification field (see
  // JobsService.resolveRequirementTypeField). Unset keeps the exact
  // previous default list (Microsoft.VSTS.CMMI.RequirementType, then
  // Custom.Requirement_Type).
  REQUIREMENT_TYPE_FIELD_CANDIDATES: z.string().optional(),
  // Tesseract OCR language pack(s) for scanned-PDF OCR fallback (NEW-04),
  // forwarded to ingestion's /ingest?languages=... (e.g. 'heb+eng' for a
  // deployment whose documents mix Hebrew and English). Previously this
  // path was fully built and tested ingestion-side but never reachable
  // from a real job -- the orchestrator never set this query param at all.
  // Unset means "don't send it," so ingestion's own 'eng' default governs,
  // unchanged from before this config existed.
  OCR_LANGUAGES: z.string().optional(),
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
  // NEW-05 batch/folder ingestion (BatchService.pumpOnce) -- global cap on
  // batch-originated SURVEY jobs concurrently in 'pending'|'running' across
  // ALL batches (the scarce resource, one real LLM generation slot in this
  // deployment's backend, is global, not per-batch). BASELINE files in a
  // batch are never throttled -- they have no LLM cost. Deliberately small:
  // enqueueing every SURVEY file in a large batch at once would make each
  // one individually crawl toward INGESTION_REQUEST_TIMEOUT_MS with zero
  // isolation between them (see docs/survey-performance.md).
  BATCH_SURVEY_CONCURRENCY: z.coerce.number().default(2),
  // BatchPumpService's poll interval -- how often queued JobBatchFile rows
  // get another look for a free slot.
  BATCH_PUMP_INTERVAL_MS: z.coerce.number().default(10_000),
  // Hard ceiling on files accepted in a single POST /batches submission.
  MAX_BATCH_FILES: z.coerce.number().default(25),
  // A JobBatchFile stuck in 'submitting' (the optimistic pre-submit claim)
  // longer than this is reclaimed back to 'queued' by the next pump tick --
  // covers a crash between the claim and the real JobsService.submit()
  // call. Comfortably above one submit() call's real cost (file read +
  // one Postgres write), well below BATCH_PUMP_INTERVAL_MS's own
  // many-tick horizon.
  BATCH_SUBMIT_STUCK_MS: z.coerce.number().default(5 * 60_000),
});

export type AppConfig = z.infer<typeof configSchema>;
