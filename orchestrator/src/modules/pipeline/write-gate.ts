// The server side of the Write gate (DESIGN.md §11.3.6). The page blocks Write while a "Fix before writing" kind is open; this is the same
// decision made where it cannot be bypassed, so an API caller, a second tab or a stale page cannot write what the page would have refused.
//
// A kind is open until its items are decided: an item is decided when it is marked reviewed, left out of the write (excluded itself, below an
// excluded ancestor, or not in the selection the caller sent), or no longer in the diff. A kind whose value is missing from the source
// (COUNTED_ACK_KINDS) can instead be cleared by acknowledging every record of it (one counted acceptance). A kind with no items is cleared
// notice by notice. Acknowledging a per-item kind never clears it: only deciding its items does.
//
// The two lists below are the browser's (frontend/src/utils/warningKinds.ts: `group: 'fix'` and `ackPolicy: 'kind_counted'`); a test reads
// that file and fails if they drift.
export const FIX_WARNING_KINDS: ReadonlySet<string> = new Set([
  'missing_source_reference',
  'duplicate_customer_id',
  'parent_title_collision',
  'zero_nodes',
  'output_truncated',
  'dropped_row',
  'trace_link_write_failed',
]);

export const COUNTED_ACK_KINDS: ReadonlySet<string> = new Set(['missing_source_reference']);

interface GateWarning {
  kind: string;
  severity?: string;
  nodeIds?: string[];
  raw?: string;
  acknowledged?: boolean;
}

interface GateEntry {
  localId: string;
  parentLocalId?: string | null;
  excluded?: boolean;
  reviewed?: boolean;
}

export interface OpenFixItems {
  remaining: number;
  blockers: { kind: string; remaining: number }[];
}

export function openFixItems(
  warnings: ReadonlyArray<GateWarning | string>,
  diff: ReadonlyArray<GateEntry>,
  selectedLocalIds?: ReadonlyArray<string>,
): OpenFixItems {
  const byId = new Map(diff.map((entry) => [entry.localId, entry]));
  const excludedCache = new Map<string, boolean>();
  // An entry is left out of the write when it, or any ancestor, is excluded (confirm drops the whole subtree). Set before recursing, so a
  // malformed parent cycle terminates.
  const isExcluded = (entry: GateEntry): boolean => {
    const cached = excludedCache.get(entry.localId);
    if (cached !== undefined) return cached;
    excludedCache.set(entry.localId, false);
    const parent = entry.parentLocalId ? byId.get(entry.parentLocalId) : undefined;
    const result = !!entry.excluded || (parent ? isExcluded(parent) : false);
    excludedCache.set(entry.localId, result);
    return result;
  };
  const selected = selectedLocalIds ? new Set(selectedLocalIds) : null;
  const isDecided = (localId: string): boolean => {
    const entry = byId.get(localId);
    if (!entry) return true;
    return !!entry.reviewed || isExcluded(entry) || (selected !== null && !selected.has(localId));
  };

  const recordsByKind = new Map<string, GateWarning[]>();
  for (const warning of warnings) {
    if (typeof warning === 'string' || !FIX_WARNING_KINDS.has(warning.kind) || warning.severity === 'auto_fixed') continue;
    const list = recordsByKind.get(warning.kind) ?? [];
    list.push(warning);
    recordsByKind.set(warning.kind, list);
  }

  const blockers: { kind: string; remaining: number }[] = [];
  for (const [kind, records] of recordsByKind) {
    const nodeIds = [...new Set(records.flatMap((record) => record.nodeIds ?? []))];
    let remaining: number;
    if (nodeIds.length > 0) {
      const countedAndAccepted = COUNTED_ACK_KINDS.has(kind) && records.every((record) => record.acknowledged === true);
      remaining = countedAndAccepted ? 0 : nodeIds.filter((localId) => !isDecided(localId)).length;
    } else {
      remaining = records.filter((record) => record.acknowledged !== true).length;
    }
    if (remaining > 0) blockers.push({ kind, remaining });
  }
  return { remaining: blockers.reduce((sum, blocker) => sum + blocker.remaining, 0), blockers };
}
