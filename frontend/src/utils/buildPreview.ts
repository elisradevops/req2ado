import type { ProposalDecision, ReadingDecision, ReadingOutlineItem } from '../api/jobs';

/** One row of the "What it will build" preview: an Epic or Feature as the job will build it with the user's decisions so far. */
export interface PreviewRow {
  id: string;
  type: 'Epic' | 'Feature';
  title: string;
  depth: number;
  requirements: number;
  /** Renamed by an accepted proposal (the title shown is the new one; `was` is the file's). */
  was: string | null;
  /** A proposal for this item is still undecided. */
  open: boolean;
}

/**
 * The outline the study built with every proposal undecided, with the user's decisions applied as the job will apply them: an accepted rename
 * shows its new name, an accepted "remove this level" takes the item out and moves its children up to its parent, and an undecided proposal
 * keeps the file's original (owner decision, 2026-11-25). Rows come in document order, each with its depth.
 */
export function applyDecisions(
  outline: ReadingOutlineItem[],
  proposals: ReadingDecision[],
  decisions: Record<string, ProposalDecision | undefined>,
): { rows: PreviewRow[]; removed: string[] } {
  const byHeading = new Map(proposals.map((p) => [p.headingId, p]));
  const dropped = new Set(
    outline.filter((o) => o.headingId && byHeading.get(o.headingId)?.action === 'drop_wrapper' && decisions[o.headingId] === 'accept').map((o) => o.id),
  );
  const byId = new Map(outline.map((o) => [o.id, o]));
  const parentOf = (item: ReadingOutlineItem): string | null => {
    let parent = item.parent;
    while (parent && dropped.has(parent)) parent = byId.get(parent)?.parent ?? null;
    return parent;
  };
  const children = new Map<string | null, ReadingOutlineItem[]>();
  for (const item of outline) {
    if (dropped.has(item.id)) continue;
    const parent = parentOf(item);
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const rows: PreviewRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const item of children.get(parent) ?? []) {
      const proposal = item.headingId ? byHeading.get(item.headingId) : undefined;
      const decision = item.headingId ? decisions[item.headingId] : undefined;
      const renamed = proposal?.action === 'rename' && decision === 'accept' && proposal.newTitle ? proposal.newTitle : null;
      rows.push({
        id: item.id,
        type: item.type,
        title: renamed ?? item.title,
        depth,
        requirements: item.requirements,
        was: renamed ? item.title : null,
        open: Boolean(proposal) && decision === undefined,
      });
      walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return { rows, removed: outline.filter((o) => dropped.has(o.id)).map((o) => o.title) };
}

/** The decisions to store with the rulebook: only the ones the user made, as the rulebook's [heading id, decision] pairs. */
export function decisionPairs(decisions: Record<string, ProposalDecision | undefined>): [string, ProposalDecision][] {
  return Object.entries(decisions)
    .filter((entry): entry is [string, ProposalDecision] => entry[1] === 'accept' || entry[1] === 'keep')
    .sort(([a], [b]) => a.localeCompare(b));
}
