import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
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
  /** The job whose `/ingest` stored this document's figure images; a hit copies that job's rows to the new job. Absent on older entries. */
  sourceJobId?: string;
  /** The figures a hit must be able to serve: those the source job kept after its prune step (referenced by its tree) and has a stored
   *  image for. Written once the source job has pruned; absent (or the entry from before this field) means "cannot be verified". */
  figureIds?: string[];
}

export interface ResultKeyParts {
  fileHash: string;
  userId: string;
  model: string;
  mode: string;
  /** `kbVersionFor` of the submitting user. */
  kbVersion: string;
  /** The ingestion build that produced the tree: an ingestion-only release must not serve the previous build's result. */
  ingestionVersion: string;
  /** The version of the KB profile the job is scored with (null without one): results scored with other categories do not apply. */
  profileVersion: string | null;
}

const TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

// A leveled tree is 1-2 MB of repetitive JSON and Valkey holds it in memory: it is stored gzipped (base64, so the store stays a string
// store). Entries written plain by earlier builds start with `{` and are still read.
const GZIP_PREFIX = 'gz:';
const encode = (json: string): string => GZIP_PREFIX + gzipSync(json).toString('base64');
const decode = (raw: string): string => (raw.startsWith(GZIP_PREFIX) ? gunzipSync(Buffer.from(raw.slice(GZIP_PREFIX.length), 'base64')).toString('utf8') : raw);

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
      .update(JSON.stringify([this.codeVersion, parts.fileHash, parts.userId, parts.model, parts.mode, parts.kbVersion, parts.ingestionVersion, parts.profileVersion]))
      .digest('hex');
    return `job-result:${digest}`;
  }

  /** The stored result, or undefined (a miss, a disabled cache, a corrupt entry and a store error all look the same). */
  async lookup(key: string): Promise<CachedResult | undefined> {
    if (!this.enabled) return undefined;
    try {
      const raw = await this.store.get(key);
      if (!raw) return undefined;
      const parsed = JSON.parse(decode(raw)) as CachedResult;
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
      await this.store.set(key, encode(serialized), 'EX', TTL_SECONDS);
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
