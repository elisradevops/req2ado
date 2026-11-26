import type { FileReading, ProposalDecision, ReadingDecision, ReadingOutlineItem } from '../api/jobs';

/** The study's proposals apply unless the user undid them ("keep") before Start (owner rule R4, 2026-11-26). */
export function isApplied(decision: ProposalDecision | null | undefined): boolean {
  return decision !== 'keep';
}

/** One row of the "What it will build" preview: an Epic or Feature as the job will build it with the user's decisions so far. */
export interface PreviewRow {
  id: string;
  type: 'Epic' | 'Feature';
  title: string;
  depth: number;
  requirements: number;
  /** Renamed by a proposal (the title shown is the new one; `was` is the file's). */
  was: string | null;
  /** The user undid this item's proposal: it keeps the file's original. */
  undone: boolean;
}

/**
 * The outline the study built with every proposal kept (the file's original), with the proposals applied as the job will apply them: a rename
 * shows its new name, a "remove this level" takes the item out and moves its children up to its parent, and a proposal the user undid keeps the
 * file's original (owner rule R4, 2026-11-26: proposals apply unless undone). Rows come in document order, each with its depth.
 */
export function applyDecisions(
  outline: ReadingOutlineItem[],
  proposals: ReadingDecision[],
  decisions: Record<string, ProposalDecision | undefined>,
): { rows: PreviewRow[]; removed: string[] } {
  const byHeading = new Map(proposals.map((p) => [p.headingId, p]));
  const dropped = new Set(
    outline.filter((o) => o.headingId && byHeading.get(o.headingId)?.action === 'drop_wrapper' && isApplied(decisions[o.headingId])).map((o) => o.id),
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
      const renamed = proposal?.action === 'rename' && isApplied(decision) && proposal.newTitle ? proposal.newTitle : null;
      rows.push({
        id: item.id,
        type: item.type,
        title: renamed ?? item.title,
        depth,
        requirements: item.requirements,
        was: renamed ? item.title : null,
        undone: Boolean(proposal) && !isApplied(decision),
      });
      walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return { rows, removed: outline.filter((o) => dropped.has(o.id)).map((o) => o.title) };
}

/** The verdict's Epic and Feature counts as the job will build them: the study counted the file's original, so a removed level is taken off. */
export function appliedCounts(reading: FileReading, decisions: Record<string, ProposalDecision | undefined>): { epics: number; features: number } {
  const byHeading = new Map(reading.decisions.map((p) => [p.headingId, p]));
  const removed = reading.outline.filter(
    (o) => o.headingId && byHeading.get(o.headingId)?.action === 'drop_wrapper' && isApplied(decisions[o.headingId]),
  );
  return {
    epics: reading.epics - removed.filter((o) => o.type === 'Epic').length,
    features: reading.features - removed.filter((o) => o.type === 'Feature').length,
  };
}

/** The decisions to store with the rulebook: only the ones the user made, as the rulebook's [heading id, decision] pairs. */
export function decisionPairs(decisions: Record<string, ProposalDecision | undefined>): [string, ProposalDecision][] {
  return Object.entries(decisions)
    .filter((entry): entry is [string, ProposalDecision] => entry[1] === 'accept' || entry[1] === 'keep')
    .sort(([a], [b]) => a.localeCompare(b));
}
