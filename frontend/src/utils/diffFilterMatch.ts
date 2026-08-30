export interface DiffFilterCandidate {
  action: string;
  title: string;
  // Row-tree display index (e.g. "3.2.1") -- only DiffTree's own rows carry
  // this; other callers simply never match on it (comparing against
  // `undefined` is always false, matching their pre-existing behavior).
  index?: string;
}

// Shared by DiffTree's own row filter and JobDetail's bulk-exclude/
// prev-next-navigation filters, which must match exactly the same set
// DiffTree shows -- previously three separately hand-written copies of
// this "(!filterAction || action-matches) && (!query || text/index-matches)"
// predicate, at real risk of drifting apart.
//
// `query` must already be `filterText.trim().toLowerCase()` -- compute it
// once per filter pass, not per candidate, in the caller.
export function matchesDiffFilter(candidate: DiffFilterCandidate, filterAction: string | null | undefined, query: string): boolean {
  if (filterAction && candidate.action !== filterAction) return false;
  if (!query) return true;
  return candidate.title.toLowerCase().includes(query) || candidate.index === query;
}
