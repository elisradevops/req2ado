import type { PrismaClient } from '@prisma/client';
import type { LlmUsage } from './llm-client.interface';

/** The OpenAI-compatible `usage` object as a proxy sends it; every field is optional because proxies differ. */
interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** The counts the upstream reported, or undefined when it reported none. Nothing is estimated here. */
export function usageOf(raw: RawUsage | null | undefined): LlmUsage | undefined {
  if (!raw) return undefined;
  const usage: LlmUsage = {};
  const prompt = count(raw.prompt_tokens);
  const completion = count(raw.completion_tokens);
  const cached = count(raw.prompt_tokens_details?.cached_tokens);
  const reasoning = count(raw.completion_tokens_details?.reasoning_tokens);
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (cached !== undefined) usage.cachedTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export interface TokenUsageEntry {
  jobId: string;
  stage: string;
  model: string;
  usage?: LlmUsage;
}

/** Adds one call to a job's per-stage ledger (JobTokenUsage). */
export class TokenUsageRecorder {
  constructor(private readonly prisma: PrismaClient) {}

  /** Best-effort: a failed write is logged and swallowed, because the ledger must never fail the model call it describes. */
  async record(entry: TokenUsageEntry): Promise<void> {
    const u = entry.usage ?? {};
    try {
      // One atomic statement: the ingestion service makes concurrent calls for the same job and stage, so a read-then-write
      // (or Prisma's upsert, which can lose the race on the unique key) would drop counts.
      await this.prisma.$executeRaw`
        INSERT INTO "JobTokenUsage" ("id", "jobId", "stage", "model", "calls", "promptTokens", "completionTokens", "cachedTokens", "reasoningTokens", "updatedAt")
        VALUES (gen_random_uuid()::text, ${entry.jobId}, ${entry.stage}, ${entry.model}, 1, ${u.promptTokens ?? 0}, ${u.completionTokens ?? 0}, ${u.cachedTokens ?? 0}, ${u.reasoningTokens ?? 0}, NOW())
        ON CONFLICT ("jobId", "stage", "model") DO UPDATE SET
          "calls" = "JobTokenUsage"."calls" + 1,
          "promptTokens" = "JobTokenUsage"."promptTokens" + EXCLUDED."promptTokens",
          "completionTokens" = "JobTokenUsage"."completionTokens" + EXCLUDED."completionTokens",
          "cachedTokens" = "JobTokenUsage"."cachedTokens" + EXCLUDED."cachedTokens",
          "reasoningTokens" = "JobTokenUsage"."reasoningTokens" + EXCLUDED."reasoningTokens",
          "updatedAt" = NOW()`;
    } catch (error) {
      // eslint-disable-next-line no-console -- no structured logger in this module yet
      console.error(`Could not record token usage for job ${entry.jobId} (${entry.stage}):`, error instanceof Error ? error.message : 'unknown error');
    }
  }
}
