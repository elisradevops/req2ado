// How the review tree is drawn, as pure functions: one place that knows it, so the tree
// (DiffTree), the details dialog's next / previous and the risk-ordered queue agree.
//
// The diff array is not the drawn order. The tree is walked depth-first from the roots,
// siblings in diff order, so a parent can be listed after its children (a wrapper Epic is).

export interface TreeOrderEntry {
  localId: string;
  parentLocalId: string | null;
}

// Siblings grouped under their parent, in diff order. An entry whose parent is not in the
// list counts as a root (key null), the same as the tree does.
export function groupByParent<T extends TreeOrderEntry>(entries: T[]): Map<string | null, T[]> {
  const ids = new Set(entries.map((entry) => entry.localId));
  const byParent = new Map<string | null, T[]>();
  for (const entry of entries) {
    const key = entry.parentLocalId && ids.has(entry.parentLocalId) ? entry.parentLocalId : null;
    const siblings = byParent.get(key);
    if (siblings) siblings.push(entry);
    else byParent.set(key, [entry]);
  }
  return byParent;
}

// The entries in the order the tree draws them. Never drops one: an entry that no root
// reaches (a malformed parent cycle) is appended after the rest, in diff order.
export function orderLikeTree<T extends TreeOrderEntry>(entries: T[]): T[] {
  const byParent = groupByParent(entries);
  const ordered: T[] = [];
  const placed = new Set<string>();
  function visit(key: string | null): void {
    for (const entry of byParent.get(key) ?? []) {
      if (placed.has(entry.localId)) continue;
      placed.add(entry.localId);
      ordered.push(entry);
      visit(entry.localId);
    }
  }
  visit(null);
  for (const entry of entries) {
    if (!placed.has(entry.localId)) ordered.push(entry);
  }
  return ordered;
}
