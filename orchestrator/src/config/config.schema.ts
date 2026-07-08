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
  ADO_CA_CERT: z.string().optional(),
  LLM_BASE_URL: z.string().min(1),
  LLM_API_KEY: z.string().optional(),
  LLM_CHAT_MODEL: z.string().min(1),
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
  INGESTION_BASE_URL: z.string().min(1).default('http://localhost:8000'),
  // Unset in production topology (frontend served same-origin behind nginx,
  // per docs/architecture.md — never actually built, see docker-compose.yml's
  // commented-out frontend service). Set for local dev, where Vite serves the
  // frontend on its own origin/port (5173) against this API (3001).
  CORS_ORIGIN: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
