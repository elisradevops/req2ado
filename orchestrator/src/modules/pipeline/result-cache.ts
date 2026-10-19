import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

// A job's expensive output (the parsed document with its figure captions, and the leveled tree) is a function of the
// file, the model, the mode, the user's knowledge base and the code that produced it. The same inputs must give the
// identical result: models that are forced to sample (Claude, GPT-5.x) cannot promise that on a rerun, so the first
// result is stored and returned for every identical request, until the file, model, KB or release changes.

export interface ResultCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export interface CachedResult {
  doc: unknown;
  tree: unknown;
  /** Hash of the link-type catalog the tree's trace links were inferred against; a different catalog re-runs leveling. */
  catalogHash: string;
}

export interface ResultKeyParts {
  fileHash: string;
  userId: string;
  model: string;
  mode: string;
  /** `kbVersionFor` of the submitting user. */
  kbVersion: string;
}

const TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

export class JobResultCache {
  constructor(
    private readonly store: ResultCacheStore,
    /** Changes with every release (and with `RESULT_CACHE_VERSION`), so new code never serves old results. */
    private readonly codeVersion: string,
    private readonly enabled: boolean = true,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  keyFor(parts: ResultKeyParts): string {
    const digest = createHash('sha256')
      .update(JSON.stringify([this.codeVersion, parts.fileHash, parts.userId, parts.model, parts.mode, parts.kbVersion]))
      .digest('hex');
    return `job-result:${digest}`;
  }

  /** The stored result, or undefined (a miss, a disabled cache, a corrupt entry and a store error all look the same). */
  async lookup(key: string): Promise<CachedResult | undefined> {
    if (!this.enabled) return undefined;
    try {
      const raw = await this.store.get(key);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as CachedResult;
      return parsed && typeof parsed === 'object' && 'tree' in parsed && 'doc' in parsed ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async save(key: string, result: CachedResult): Promise<void> {
    if (!this.enabled) return;
    try {
      const serialized = JSON.stringify(result);
      if (serialized.length > this.maxBytes) return;
      await this.store.set(key, serialized, 'EX', TTL_SECONDS);
    } catch {
      /* a cache that cannot be written is just a cache that does not help */
    }
  }
}

export function hashCatalog(catalog: { referenceName: string; name: string; semanticHint?: string }[]): string {
  const normal = catalog.map((t) => `${t.referenceName}|${t.name}|${t.semanticHint ?? ''}`).sort();
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 24);
}

/** A version of the user's knowledge base: its documents and when each was ingested. null when it cannot be read. */
export async function kbVersionFor(prisma: PrismaClient, userId: string): Promise<string | null> {
  try {
    const rows = await prisma.ingestedDocument.findMany({ where: { userId }, select: { id: true, ingestedAt: true } });
    if (rows.length === 0) return 'no-kb';
    const normal = rows.map((r) => `${r.id}|${new Date(r.ingestedAt).toISOString()}`).sort();
    return createHash('sha256').update(JSON.stringify(normal)).digest('hex').slice(0, 24);
  } catch {
    return null;
  }
}

/** The version of the running release (its package.json), or null when it cannot be read: then nothing is cached, because
 *  a result could outlive the code that produced it. */
export function releaseVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('node:path') as typeof import('node:path');
    const parsed = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Warning kinds that mean a stage fell short for a transient reason; such a result is not stored, so a rerun can do better. */
const DEGRADED_WARNING_KINDS = new Set(['scoring_failed', 'trace_links_partial', 'items_lost', 'conflict_judgment_skipped']);

export function isDegradedResult(warnings: { kind: string }[] | undefined, figures: { caption_status?: string }[] | undefined): boolean {
  return (warnings ?? []).some((w) => DEGRADED_WARNING_KINDS.has(w.kind)) || (figures ?? []).some((f) => f.caption_status === 'vision_failed');
}
