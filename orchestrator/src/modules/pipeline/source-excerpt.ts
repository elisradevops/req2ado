// The original wording behind one item, for the review dialog's evidence strip (GET /jobs/:id/diff/:localId/source).
//
// An item stores only offsets, and they index the text ingestion EXTRACTED, not the file's bytes, so the words cannot be
// sliced from the stored upload here: ingestion re-parses the job's JobSourceFile with the pipeline's own loader and reads
// the span (ingestion/app/source_excerpt.py). Every way the wording can be missing is a normal answer, never an error:
// - no_original: the upload was not kept (over the size cap, a swallowed save, or a job from before retention).
// - no_span: the item has no location of its own (added by hand, a grouping item the pipeline made, a (0,0) placeholder),
//   or ingestion found no source wording there (a figure, a table placeholder).
// - parse_failed: ingestion failed or did not answer in time. Not remembered, so the next open tries again.

export type EntrySourceKind = 'text' | 'table' | 'section';
export type EntrySourceAnswer =
  | { kind: EntrySourceKind; text: string; truncated: boolean }
  | { kind: 'unavailable'; reason: 'no_original' | 'no_span' | 'parse_failed' };

export interface SourceExcerptRequest {
  startOffset: number;
  endOffset: number;
  page: number | null;
  // 'section' for a SURVEY item: every item written from one section carries that section's first block as its ref.
  extent: 'span' | 'section';
  // The item's document id: all rows of a table share the table's ref, so ingestion narrows a table to the matching row.
  rowHint: string | null;
}

export interface IngestionSourceExcerpt {
  text: string;
  truncated: boolean;
  kind: EntrySourceKind | 'unavailable';
}

export const ENTRY_SOURCE_CACHE_MAX_ENTRIES = 100;
export const ENTRY_SOURCE_CACHE_TTL_MS = 10 * 60 * 1000;
// A re-parse of a big or scanned PDF can be slow; the dialog never waits longer than this. Ingestion keeps the parse it
// finishes anyway, so a later open of the same file is quick.
export const ENTRY_SOURCE_TIMEOUT_MS = 10_000;

interface StoredJob {
  id: string;
  mode: string;
  originalFilename: string;
  dryRunDiff: unknown;
}

interface StoredEntry {
  localId?: unknown;
  customerId?: unknown;
  sourceRef?: { startOffset?: unknown; endOffset?: unknown; page?: unknown } | null;
}

export class EntrySourceReader {
  private readonly entries = new Map<string, { answer: EntrySourceAnswer; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly loadOriginal: (jobId: string) => Promise<Buffer | null>,
    private readonly fetchExcerpt: (bytes: Buffer, filename: string, request: SourceExcerptRequest, signal: AbortSignal) => Promise<IngestionSourceExcerpt>,
    options: { maxEntries?: number; ttlMs?: number; timeoutMs?: number; now?: () => number } = {},
  ) {
    this.maxEntries = options.maxEntries ?? ENTRY_SOURCE_CACHE_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? ENTRY_SOURCE_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? ENTRY_SOURCE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** null: the job has no such entry (the route's 404). */
  async read(job: StoredJob, localId: string): Promise<EntrySourceAnswer | null> {
    const entry = Array.isArray(job.dryRunDiff)
      ? (job.dryRunDiff as StoredEntry[]).find((candidate) => candidate?.localId === localId)
      : undefined;
    if (!entry) return null;

    const request = requestFor(entry, localId, job.mode);
    if (!request) return { kind: 'unavailable', reason: 'no_span' };

    const key = JSON.stringify([job.id, request.startOffset, request.endOffset, request.page, request.extent, request.rowHint]);
    const cached = this.get(key);
    if (cached) return cached;

    const bytes = await this.loadOriginal(job.id);
    if (!bytes) return { kind: 'unavailable', reason: 'no_original' };

    let answer: EntrySourceAnswer;
    try {
      const excerpt = await this.fetchExcerpt(bytes, job.originalFilename, request, AbortSignal.timeout(this.timeoutMs));
      answer = excerpt.kind === 'unavailable' || !excerpt.text
        ? { kind: 'unavailable', reason: 'no_span' }
        : { kind: excerpt.kind, text: excerpt.text, truncated: excerpt.truncated === true };
    } catch {
      return { kind: 'unavailable', reason: 'parse_failed' };
    }
    this.set(key, answer);
    return answer;
  }

  private get(key: string): EntrySourceAnswer | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    if (hit.expiresAt <= this.now()) return undefined;
    this.entries.set(key, hit); // most recently used goes last
    return hit.answer;
  }

  private set(key: string, answer: EntrySourceAnswer): void {
    this.entries.delete(key);
    this.entries.set(key, { answer, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }
}

function requestFor(entry: StoredEntry, localId: string, mode: string): SourceExcerptRequest | null {
  // "synth_" is ingestion's marker for an item it made to group others (see scoring.py, hierarchy_rules.py): it borrows a
  // member's ref, so the words there are that member's, not its own.
  if (localId.includes('synth_')) return null;
  const ref = entry.sourceRef;
  if (!ref) return null;
  const { startOffset, endOffset, page } = ref;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return null;
  if ((startOffset as number) < 0 || (endOffset as number) <= (startOffset as number)) return null;
  return {
    startOffset: startOffset as number,
    endOffset: endOffset as number,
    page: Number.isInteger(page) ? (page as number) : null,
    extent: mode === 'survey' ? 'section' : 'span',
    rowHint: typeof entry.customerId === 'string' && entry.customerId.trim() ? entry.customerId.trim() : null,
  };
}
