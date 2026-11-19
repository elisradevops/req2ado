import { createHash } from 'node:crypto';

// Remembers the answer to "how does this suggestion compare with the item?" so reopening a suggestion (stepping back to the item, closing and
// opening the chat) costs no second model call (DESIGN.md §11.4.6). Process-local on purpose: it is an optimisation, not state, so a restart or
// another replica merely asks again. Keyed by the job, the item and BOTH texts, so an edit of the item or a different suggestion never hits.

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

export class RewriteCheckCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  static key(parts: { jobId: string; localId: string; title: string; description: string; proposedTitle: string | null; proposedDescription: string }): string {
    return createHash('sha256')
      .update([parts.jobId, parts.localId, parts.title, parts.description, parts.proposedTitle ?? '', parts.proposedDescription].join('\u0000'))
      .digest('hex');
  }

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so the least recently used entry is the first to go.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
